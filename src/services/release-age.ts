/**
 * Release-age gate discovery and publish-time helpers.
 *
 * pnpm's `minimumReleaseAge` / `minimumReleaseAgeExclude` settings reject
 * versions published inside the cutoff window at install time
 * (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The action mirrors that gate at
 * resolution time so it never proposes a version pnpm would refuse to
 * install. The effective settings come from two sources:
 *
 * - inline keys in `pnpm-workspace.yaml` (`readInlineReleaseAge`), and
 * - config-dependency `pnpmfile` `updateConfig` hooks
 *   (`replayHookReleaseAge`) — pnpm does not replay hooks for
 *   `pnpm config get`, so repos that receive the settings via a config
 *   dependency (e.g. `@savvy-web/pnpm-plugin-silk`) can only be read by
 *   replaying the hooks.
 *
 * The replay runs in a `node` subprocess via `@effected/commands`' `Run`
 * rather than an in-process dynamic `import()`: the rspack bundle miscompiles
 * a computed dynamic import into a context module (see the `action.config.ts`
 * note on `nativeDynamicImports`), and a subprocess also keeps
 * config-dependency code out of the action's own process. Discovery is
 * best-effort by design — any failure degrades to "no gate" (today's
 * behavior) with a warning rather than failing the run.
 *
 * Combining the two sources, exclude matching, and version filtering are
 * deliberately NOT implemented here — that vocabulary lives upstream in
 * `@effected/npm` (`ReleaseAgeGate`), as does publish-time fetching
 * (`NpmRegistry.publishTimes`), which replaced this module's hand-rolled
 * `npm view <pkg> time --json` shell-out.
 *
 * @module services/release-age
 */

import { Run } from "@effected/commands";
import type { PartialReleaseAgeGate } from "@effected/npm";
import { NpmRegistry, ReleaseAgeGate } from "@effected/npm";
import { Context, DateTime, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { FileSystemError } from "../errors/errors.js";
import { readWorkspaceYaml } from "./workspace-yaml.js";

export type { PartialReleaseAgeGate } from "@effected/npm";

/**
 * Build a gate from raw `minimumReleaseAge` / `minimumReleaseAgeExclude`
 * values, or `null` when neither is usable.
 */
const gateFrom = (age: unknown, exclude: unknown): PartialReleaseAgeGate | null => {
	const out: { ageMinutes?: number; exclude?: readonly string[] } = {};
	if (typeof age === "number" && Number.isFinite(age)) {
		out.ageMinutes = age;
	}
	if (Array.isArray(exclude)) {
		const patterns = exclude.filter((entry): entry is string => typeof entry === "string");
		if (patterns.length > 0) {
			out.exclude = patterns;
		}
	}
	return out.ageMinutes === undefined && out.exclude === undefined ? null : out;
};

/**
 * Read the release-age gate declared inline in `pnpm-workspace.yaml`.
 *
 * @param workspaceRoot - Workspace root (defaults to cwd)
 * @returns The inline gate values, or `null` when neither key is declared
 */
export const readInlineReleaseAge = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<PartialReleaseAgeGate | null, FileSystemError> =>
	Effect.gen(function* () {
		const content = yield* readWorkspaceYaml(workspaceRoot);
		if (content === null) {
			return null;
		}
		return gateFrom(content.minimumReleaseAge, content.minimumReleaseAgeExclude);
	});

/**
 * The subprocess program that replays config-dependency `updateConfig` hooks
 * and prints the release-age slice of the resulting config as JSON.
 *
 * Receives the workspace root and the config-dependency names as argv (never
 * string-interpolated — `Run` spawns without a shell).
 * Mirrors pnpm 11's loader order (`pnpmfile.mjs` first, `pnpmfile.cjs`
 * fallback) and tolerates every per-dependency failure: a dependency whose
 * pnpmfile is missing, fails to load, or throws contributes nothing. This is
 * lenient where `@effected/workspaces`' `ConfigDependencyHooks` fails typed,
 * because discovery here is best-effort — a lost gate degrades to today's
 * behavior instead of failing the run.
 */
const REPLAY_SCRIPT = `
const [root, ...names] = process.argv.slice(1);
const { pathToFileURL } = await import("node:url");
const { join } = await import("node:path");
let config = { catalog: {}, catalogs: {} };
for (const name of names) {
	let mod;
	for (const filename of ["pnpmfile.mjs", "pnpmfile.cjs"]) {
		try {
			mod = await import(pathToFileURL(join(root, "node_modules", ".pnpm-config", name, filename)).href);
			break;
		} catch {}
	}
	if (!mod) continue;
	const candidates = [mod, mod.default].filter((m) => m && typeof m === "object");
	let hook;
	for (const candidate of candidates) {
		if (candidate.hooks && typeof candidate.hooks.updateConfig === "function") {
			hook = candidate.hooks.updateConfig;
			break;
		}
		if (typeof candidate.updateConfig === "function") {
			hook = candidate.updateConfig;
			break;
		}
	}
	if (!hook) continue;
	try {
		const next = await hook(config);
		if (next && typeof next === "object") config = next;
	} catch {}
}
process.stdout.write(JSON.stringify({
	minimumReleaseAge: config.minimumReleaseAge,
	minimumReleaseAgeExclude: config.minimumReleaseAgeExclude,
}));
`;

/**
 * Replay the workspace's config-dependency `updateConfig` hooks in a `node`
 * subprocess and read the release-age gate they inject.
 *
 * @param workspaceRoot - Workspace root (defaults to cwd)
 * @returns The hook-injected gate values, or `null` when there are no config
 *   dependencies, no hook sets the keys, or the replay fails (best-effort)
 */
export const replayHookReleaseAge = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<PartialReleaseAgeGate | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const content = yield* readWorkspaceYaml(workspaceRoot).pipe(Effect.catch(() => Effect.succeed(null)));
		const configDependencies = content?.configDependencies ?? {};
		// A `..` path segment would escape node_modules/.pnpm-config — skip it.
		const names = Object.keys(configDependencies).filter((name) => !name.split(/[/\\]/).includes(".."));
		if (names.length === 0) {
			return null;
		}

		// Run.collect treats a non-zero exit as a result, so a replay that runs
		// but exits non-zero is handled by the exitCode check below rather than
		// the spawn-failure catch.
		const command = ChildProcess.make("node", ["--input-type=module", "-e", REPLAY_SCRIPT, workspaceRoot, ...names]);
		const result = yield* Run.collect(command).pipe(Effect.catch(() => Effect.succeed(null)));
		if (result === null || !result.succeeded) {
			yield* Effect.logWarning("Config-dependency hook replay failed; release-age gate from hooks unavailable");
			return null;
		}

		const parsed = yield* Effect.try({
			try: () => JSON.parse(result.stdout) as { minimumReleaseAge?: unknown; minimumReleaseAgeExclude?: unknown },
			catch: () => null,
		}).pipe(Effect.catch(() => Effect.succeed(null)));
		if (parsed === null) {
			yield* Effect.logWarning("Config-dependency hook replay produced unparseable output; ignoring");
			return null;
		}

		return gateFrom(parsed.minimumReleaseAge, parsed.minimumReleaseAgeExclude);
	});

/**
 * Fetch a package's publish timestamps from the npm registry, keyed by version.
 *
 * Delegates to `@effected/npm`'s `NpmRegistry.publishTimes`, which owns the
 * registry read and already drops the `time` object's non-version `created` /
 * `modified` entries — the exclusion this module used to re-derive from a raw
 * `npm view <pkg> time --json` shell-out.
 *
 * Best-effort: a failed query yields an empty record, which downstream
 * filtering treats as "no timestamp data" for every version.
 *
 * @param pkg - Package name
 * @returns Version → ISO-8601 publish timestamp record
 */
export const getPublishTimes = (pkg: string): Effect.Effect<Record<string, string>, never, NpmRegistry> =>
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;
		const published = yield* registry.publishTimes(pkg).pipe(Effect.catch(() => Effect.succeed(null)));
		if (published === null) {
			yield* Effect.logWarning(`Failed to fetch publish times for ${pkg}; release-age filtering unavailable`);
			return {};
		}

		const times: Record<string, string> = {};
		for (const entry of published) {
			times[entry.version] = DateTime.formatIso(entry.publishedAt);
		}
		return times;
	});

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The effective release-age gate for the workspace, applied to candidate
 * version lists before resolution so the action never proposes a version
 * pnpm's own `minimumReleaseAge` check would refuse at install time.
 */
export class ReleaseAge extends Context.Service<
	ReleaseAge,
	{
		/** The effective gate (inline + hook sources, strictest wins). */
		readonly gate: () => Effect.Effect<ReleaseAgeGate>;
		/**
		 * Drop candidate versions of `pkg` younger than the gate's cutoff.
		 * Identity when the gate is inert, the package is excluded, or publish
		 * times are unavailable (fail open — worst case is today's behavior).
		 */
		readonly filterVersions: (pkg: string, versions: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
	}
>()("ReleaseAge") {}

/**
 * Live layer factory. The workspace root is bound when the layer is built
 * (mirroring the `@effected/workspaces` root-bound layer idiom); the gate is
 * assembled once on first use and cached for the layer's lifetime.
 */
export const ReleaseAgeLive = (
	workspaceRoot: string = process.cwd(),
): Layer.Layer<ReleaseAge, never, ChildProcessSpawner.ChildProcessSpawner | NpmRegistry> =>
	Layer.effect(
		ReleaseAge,
		Effect.gen(function* () {
			// Both dependencies are resolved once here, so every member's R is
			// `never` — which is what keeps `filterVersions` usable from the
			// ConfigDeps/RegularDeps call sites without threading requirements.
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const registry = yield* NpmRegistry;

			const assembleGate = Effect.gen(function* () {
				const inline = yield* readInlineReleaseAge(workspaceRoot).pipe(Effect.catch(() => Effect.succeed(null)));
				const hooks = yield* replayHookReleaseAge(workspaceRoot).pipe(
					Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
				);
				const contributions = [inline, hooks].filter(
					(contribution): contribution is PartialReleaseAgeGate => contribution !== null,
				);
				const gate = ReleaseAgeGate.combine(...contributions);
				if (gate.ageMinutes > 0) {
					yield* Effect.logInfo(
						`Release-age gate active: ${gate.ageMinutes} minute minimum, ${gate.exclude.length} exclude pattern(s)`,
					);
				}
				return gate;
			});
			const cachedGate = yield* Effect.cached(assembleGate);

			const filterVersions = (
				pkg: string,
				versions: ReadonlyArray<string>,
			): Effect.Effect<ReadonlyArray<string>, never, never> =>
				Effect.gen(function* () {
					const gate = yield* cachedGate;
					if (gate.ageMinutes <= 0 || gate.isExcluded(pkg)) {
						return versions;
					}

					const times = yield* getPublishTimes(pkg).pipe(Effect.provideService(NpmRegistry, registry));
					// Fail open on missing publish-time data: pnpm would fail closed,
					// but for resolution-time mirroring the worst case of proposing an
					// unverifiable version is exactly today's behavior — and a warning
					// was already logged by getPublishTimes.
					if (Object.keys(times).length === 0) {
						return versions;
					}

					const eligible = gate.filterVersions([...versions], times, pkg, Date.now());
					const dropped = versions.length - eligible.length;
					if (dropped > 0) {
						yield* Effect.logInfo(
							`Release-age gate: holding back ${dropped} version(s) of ${pkg} younger than ${gate.ageMinutes} minutes`,
						);
					}
					return eligible;
				});

			return {
				gate: () => cachedGate,
				filterVersions,
			};
		}),
	);

/**
 * Inert test layer: the zero gate, identity filtering. What non-pnpm and
 * unit-test paths should wire.
 */
export const ReleaseAgeNoop: Layer.Layer<ReleaseAge> = Layer.succeed(ReleaseAge, {
	gate: () => Effect.succeed(ReleaseAgeGate.combine()),
	filterVersions: (_pkg, versions) => Effect.succeed(versions),
});
