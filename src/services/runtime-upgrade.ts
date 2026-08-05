/**
 * RuntimeUpgrade service for devEngines.runtime upgrades.
 *
 * Reads the root package.json, resolves the latest version satisfying a target
 * range (per runtime) via runtime-resolver, and writes the resolved version
 * back into the existing devEngines.runtime entry — preserving the object/array
 * shape. Mirrors PackageManagerUpgrade; resolver failures are caught and
 * skipped per-runtime, never fatal.
 *
 * Two rules govern the write:
 *
 * 1. **Upgrade only, never add.** These inputs upgrade the runtimes a repo
 *    already declares; they do not introduce new ones. When no
 *    `devEngines.runtime` entry exists for the runtime there is nothing to
 *    upgrade, so it is skipped with a warning — in *every* mode, `auto` and
 *    explicit range alike. (An earlier version let an explicit range add a
 *    missing entry, so a bun-only repo passing `upgrade-runtime-node` grew a
 *    node entry it never asked for.)
 * 2. **Always write an exact version.** The range — the existing entry's own
 *    version under `auto`, or the user-typed input range — only selects *which
 *    line to resolve*; the value written is always the bare resolved version,
 *    with no range operator. Downstream consumers of `devEngines.runtime`
 *    (notably silk-runtime-action, the next step in the pipeline) do not
 *    support range operators, so any operator written here is a latent failure
 *    downstream. An existing `"^24.0.0"` therefore resolves within `^24.0.0`
 *    and is rewritten as e.g. `"24.9.1"`.
 *
 * @module services/runtime-upgrade
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ResolvedVersions } from "@effected/runtimes";
import { BunResolver, DenoResolver, NodeResolver } from "@effected/runtimes";
import { Context, Effect, Layer } from "effect";

import { FileSystemError } from "../errors/errors.js";
import { detectIndent } from "../utils/pnpm.js";
import type { RuntimeName } from "../utils/runtime.js";
import { findRuntimeEntry, isStaticVersion } from "../utils/runtime.js";

/**
 * Structural view of a `@effected/runtimes` resolver. All three resolvers share
 * this `resolve` signature (the option key is `range`, and the resolved result
 * carries `latest`); the concrete error channel is narrower than `unknown` and
 * so assignable to it.
 */
interface RuntimeResolver {
	readonly resolve: (options?: { readonly range?: string }) => Effect.Effect<ResolvedVersions, unknown>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Result of a single runtime upgrade. `from` is always the version the manifest
 * already declared (an upgrade requires an existing entry) and `to` is always a
 * bare, exact version.
 */
export interface RuntimeUpgradeResult {
	readonly runtime: RuntimeName;
	readonly from: string;
	readonly to: string;
}

/** Per-runtime mode: "false" | "auto" | a semver range. */
export interface RuntimeUpgradeConfig {
	readonly node: string;
	readonly deno: string;
	readonly bun: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class RuntimeUpgrade extends Context.Service<
	RuntimeUpgrade,
	{
		readonly upgrade: (
			config: RuntimeUpgradeConfig,
			workspaceRoot?: string,
		) => Effect.Effect<readonly RuntimeUpgradeResult[], FileSystemError>;
	}
>()("RuntimeUpgrade") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const node = yield* NodeResolver;
			const deno = yield* DenoResolver;
			const bun = yield* BunResolver;
			return {
				upgrade: (config, workspaceRoot = process.cwd()) => upgradeImpl({ node, deno, bun }, config, workspaceRoot),
			};
		}),
	);
}

// ── Implementation ──────────────────────────────────────────────────────────────

const fsReadError = (path: string, e: unknown) => new FileSystemError({ operation: "read", path, reason: String(e) });
const fsWriteError = (path: string, e: unknown) => new FileSystemError({ operation: "write", path, reason: String(e) });

interface Resolvers {
	readonly node: RuntimeResolver;
	readonly deno: RuntimeResolver;
	readonly bun: RuntimeResolver;
}

/** Resolve `.latest` for a target range; null on any resolver failure (logged). */
const resolveLatest = (
	resolver: RuntimeResolver,
	runtime: RuntimeName,
	semverRange: string,
): Effect.Effect<string | null, never> =>
	resolver.resolve({ range: semverRange }).pipe(
		// Note: r.source ("api"/"cache") is runtime-resolver's data-origin label on
		// the snapshot, not a live-fetch indicator — the offline cache reports
		// "api" without any network call — so it is deliberately not logged here.
		Effect.tap((r) => Effect.logInfo(`Resolved ${runtime} ${semverRange} -> ${r.latest}`)),
		Effect.map((r) => r.latest as string | null),
		Effect.catch((e) =>
			Effect.as(Effect.logWarning(`Could not resolve ${runtime} for range "${semverRange}": ${String(e)}`), null),
		),
	);

const upgradeOne = (
	resolver: RuntimeResolver,
	runtime: RuntimeName,
	mode: string,
	pkgJson: Record<string, unknown>,
): Effect.Effect<RuntimeUpgradeResult | null, never> =>
	Effect.gen(function* () {
		if (mode === "false") return null;

		// Upgrade only, never add: with no existing entry there is nothing to
		// upgrade — in auto mode and explicit-range mode alike.
		const entry = findRuntimeEntry(pkgJson.devEngines, runtime);
		if (!entry?.version) {
			yield* Effect.logWarning(
				`upgrade-runtime-${runtime}: no devEngines.runtime entry exists for ${runtime}, so there is nothing to ` +
					`upgrade (upgrade-runtime-${runtime} upgrades a runtime this repo already declares, it never adds one); skipping`,
			);
			return null;
		}

		// The range only selects which line to resolve: auto reuses the existing
		// entry's own range, an explicit input range overrides it.
		let targetRange: string;
		if (mode === "auto") {
			if (isStaticVersion(entry.version)) {
				yield* Effect.logInfo(`${runtime} is pinned to ${entry.version}, auto leaves it unchanged`);
				return null;
			}
			targetRange = entry.version;
		} else {
			targetRange = mode;
		}

		const resolved = yield* resolveLatest(resolver, runtime, targetRange);
		if (resolved === null) return null;

		// The resolved version is written bare — no operator is ever re-attached.
		const from = entry.version;
		if (resolved === from) {
			yield* Effect.logInfo(`${runtime} ${from} is already current`);
			return null;
		}

		entry.version = resolved;
		return { runtime, from, to: resolved };
	});

const upgradeImpl = (
	resolvers: Resolvers,
	config: RuntimeUpgradeConfig,
	workspaceRoot: string,
): Effect.Effect<readonly RuntimeUpgradeResult[], FileSystemError> =>
	Effect.gen(function* () {
		const packageJsonPath = `${workspaceRoot}/package.json`;

		const raw = yield* Effect.try({
			try: () => readFileSync(packageJsonPath, "utf-8"),
			catch: (e) => fsReadError(packageJsonPath, e),
		});
		const pkgJson = yield* Effect.try({
			try: () => JSON.parse(raw) as Record<string, unknown>,
			catch: (e) => fsReadError(packageJsonPath, `Invalid JSON: ${e}`),
		});
		const indent = detectIndent(raw);

		const plan: ReadonlyArray<[RuntimeName, Resolvers[keyof Resolvers], string]> = [
			["node", resolvers.node, config.node],
			["deno", resolvers.deno, config.deno],
			["bun", resolvers.bun, config.bun],
		];

		const results: RuntimeUpgradeResult[] = [];
		for (const [runtime, resolver, mode] of plan) {
			const result = yield* upgradeOne(resolver, runtime, mode, pkgJson);
			if (result) results.push(result);
		}

		if (results.length > 0) {
			yield* Effect.try({
				try: () => writeFileSync(packageJsonPath, `${JSON.stringify(pkgJson, null, indent)}\n`, "utf-8"),
				catch: (e) => fsWriteError(packageJsonPath, e),
			});
		}

		return results;
	});
