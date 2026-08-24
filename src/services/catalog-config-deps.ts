/**
 * CatalogConfigDeps - reproduce pnpm's config-dependency workflow for bun.
 *
 * pnpm reads config dependencies from `pnpm-workspace.yaml` and merges each
 * one's catalogs in memory at install time. bun has no such concept: the
 * package named in the `config-dependencies` input is an ordinary dependency of
 * the root manifest, so this service fetches its module, reads its `catalogs`
 * export, and merges it into the manifest's own top-level `catalog` (the default
 * catalog) and `catalogs` (the named ones) fields — siblings of `workspaces`,
 * not nested inside it, which is where bun reads them from. The manifest becomes
 * the merged artifact. A nested `workspaces.catalog` / `workspaces.catalogs`
 * copy is still read (a repo may have been written that way) and is migrated to
 * the top level on write — see `utils/catalogs.ts`.
 *
 * Because the merge is written to disk rather than recomputed each install, a
 * later run cannot tell a deliberate user override from an entry the action
 * itself wrote. `threeWayMergeCatalogs` separates them by diffing against the
 * catalogs of the version that was actually installed last run — which is what
 * the lockfile records, hence the `LockfileReader` dependency.
 *
 * Nothing here is fatal except a manifest that cannot be read or written: any
 * per-dependency failure warns and skips that dependency, and the rest proceed.
 *
 * @module services/catalog-config-deps
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageTarball } from "@effected/npm";
import { NpmRegistry } from "@effected/npm";
import { LockfileReader } from "@effected/workspaces";
import { Context, Effect, Layer, Option } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { FileSystemError } from "../errors/errors.js";
import type { CatalogDelta, DependencyUpdateResult } from "../schema/domain.js";
import type { CatalogMap } from "../utils/catalogs.js";
import { readManifestCatalogs, threeWayMergeCatalogs, writeManifestCatalogs } from "../utils/catalogs.js";
import { parseSpecifier } from "../utils/deps.js";
import { detectIndent } from "../utils/pnpm.js";
import { resolutionRangeForSpecifier, resolveLatestSatisfying } from "../utils/semver.js";
import { fetchModuleCatalogs } from "./module-catalogs.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

/** The updates and catalog deltas produced by one config-dependency pass. */
export interface CatalogConfigDepsResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly deltas: ReadonlyArray<CatalogDelta>;
}

export class CatalogConfigDeps extends Context.Service<
	CatalogConfigDeps,
	{
		readonly update: (
			deps: ReadonlyArray<string>,
			workspaceRoot: string,
		) => Effect.Effect<CatalogConfigDepsResult, FileSystemError>;
	}
>()("CatalogConfigDeps") {
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
			// The implementation yields `fetchModuleCatalogs`, which carries its own
			// requirements (NpmRegistry, HttpClient, ChildProcessSpawner). Capturing the
			// context here and re-providing it keeps the service method's R = never
			// without threading each service through by hand.
			const context = yield* Effect.context<
				NpmRegistry | PackageTarball | LockfileReader | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
			>();
			return {
				update: (deps, workspaceRoot) => updateImpl(deps, workspaceRoot).pipe(Effect.provide(context)),
			};
		}),
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/** The manifest sections a config dependency may be declared in, in lookup order. */
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

type Manifest = Record<string, unknown>;

interface LocatedDep {
	readonly field: (typeof DEP_SECTIONS)[number];
	readonly specifier: string;
}

/** Find a dependency's declared specifier in the root manifest, or `null`. */
const findDependency = (manifest: Manifest, name: string): LocatedDep | null => {
	for (const field of DEP_SECTIONS) {
		const section = manifest[field];
		if (typeof section !== "object" || section === null) continue;
		const specifier = (section as Record<string, unknown>)[name];
		if (typeof specifier === "string") return { field, specifier };
	}
	return null;
};

/**
 * Merge a new version's catalogs on top of the manifest's, plugin-wins.
 *
 * The degraded merge used when the base version's catalogs cannot be read (a
 * yanked or unpublished version): `next` overwrites every key it defines,
 * disk-only keys survive, and nothing is removed. Without a base there is no way
 * to tell a user override from a stale entry the action wrote itself, so an
 * override on a key the plugin still ships is lost — the caller warns about
 * exactly that.
 */
const pluginWinsMerge = (
	disk: CatalogMap,
	next: CatalogMap,
): { merged: CatalogMap; deltas: ReadonlyArray<CatalogDelta> } => {
	const merged: CatalogMap = structuredClone(disk);
	const deltas: Array<CatalogDelta> = [];

	for (const [catalog, nextEntries] of Object.entries(next)) {
		const entries: Record<string, string> = { ...(disk[catalog] ?? {}) };

		for (const [dependency, incoming] of Object.entries(nextEntries)) {
			const previous = entries[dependency];
			if (previous === incoming) continue;
			entries[dependency] = incoming;
			deltas.push({
				catalog,
				dependency,
				from: previous ?? null,
				to: incoming,
				action: previous === undefined ? "added" : "updated",
			});
		}

		merged[catalog] = entries;
	}

	return { merged, deltas };
};

/** Merge one catalog map on top of another, entry by entry — `right` wins. */
const mergeCatalogMaps = (left: CatalogMap, right: CatalogMap): CatalogMap => {
	const result: CatalogMap = structuredClone(left);
	for (const [catalog, entries] of Object.entries(right)) {
		result[catalog] = { ...(result[catalog] ?? {}), ...entries };
	}
	return result;
};

/**
 * Fold the catalog entries written by earlier config dependencies *in this run*
 * into a dependency's merge base — but only for the keys this dependency itself
 * ships.
 *
 * Config dependencies merge in listed order onto one accumulating manifest, so a
 * later one sees the earlier one's entries already on "disk". For a key both
 * ship, those entries would otherwise look like user overrides — diverging from
 * the later plugin's own base — and be frozen, making the *first* listed
 * dependency win a conflicting key instead of the last. Overlaying such a key
 * onto the base marks it as ours, so the later plugin overwrites it, while a
 * genuine user override (matching neither plugin's value) still diverges and
 * still survives.
 *
 * The `next[catalog]?.[key] !== undefined` restriction is what makes that safe.
 * {@link threeWayMergeCatalogs} manages every key of `base` ∪ `next`, and treats
 * a managed key the disk agrees with `base` on but `next` omits as an upstream
 * *removal*. Overlaying a key the current dependency does not ship would
 * therefore hand it authority to delete an earlier dependency's entries — its
 * own private keys, or a whole catalog it never shipped. The overlay may only
 * ever *unfreeze* a key for update, never authorize a removal, so it is confined
 * to keys `next` actually defines.
 */
const overlayOwned = (base: CatalogMap, owned: CatalogMap, next: CatalogMap): CatalogMap => {
	const result: CatalogMap = structuredClone(base);

	for (const [catalog, entries] of Object.entries(owned)) {
		const shipped = next[catalog];
		// A catalog this dependency does not ship at all is none of its business:
		// overlaying it would make every one of its keys look like a removal.
		if (shipped === undefined) continue;

		const merged: Record<string, string> = { ...result[catalog] };
		for (const [dependency, range] of Object.entries(entries)) {
			// A key this dependency does not ship stays out of the base, so it reads as
			// an override and is kept — never as a removal.
			if (shipped[dependency] !== undefined) {
				merged[dependency] = range;
			}
		}
		result[catalog] = merged;
	}

	return result;
};

/**
 * The version whose catalogs were merged into the manifest last run: the one the
 * lockfile says is installed.
 *
 * With no lockfile entry (or an unreadable lockfile) the best available stand-in
 * is the highest published version satisfying the manifest's *declared*
 * specifier — what an install would have resolved. That literal range is
 * deliberately not the widened resolution range used for `next`: widening is how
 * the dependency moves forward, and applying it here would make the base equal
 * the next version and merge nothing.
 */
const resolveBaseVersion = (
	name: string,
	specifier: { prefix: string; version: string },
	versions: ReadonlyArray<string>,
): Effect.Effect<string, never, LockfileReader> =>
	Effect.gen(function* () {
		const lockfile = yield* LockfileReader;
		const resolved = yield* lockfile
			.resolvedVersion(name)
			.pipe(Effect.catch(() => Effect.succeed(Option.none<{ readonly version: string }>())));

		if (Option.isSome(resolved)) {
			return resolved.value.version;
		}

		yield* Effect.logWarning(
			`CatalogConfigDeps: no lockfile entry for ${name}; falling back to the highest version satisfying "${specifier.prefix}${specifier.version}" as the merge base`,
		);

		const fallback = yield* resolveLatestSatisfying(versions, `${specifier.prefix}${specifier.version}`);
		return fallback ?? specifier.version;
	});

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/** Everything one config dependency contributes to the run. */
interface DepOutcome {
	readonly catalogs: CatalogMap;
	readonly deltas: ReadonlyArray<CatalogDelta>;
	readonly update: DependencyUpdateResult | null;
	readonly specifier: string | null;
	readonly field: (typeof DEP_SECTIONS)[number] | null;
	/** The catalogs this dependency shipped, i.e. the entries it now owns. */
	readonly contributed: CatalogMap;
}

/** Nothing to contribute: the dependency was warned about and skipped. */
const skipped = (catalogs: CatalogMap): DepOutcome => ({
	catalogs,
	deltas: [],
	update: null,
	specifier: null,
	field: null,
	contributed: {},
});

/**
 * Resolve, fetch and merge one config dependency onto the accumulating catalogs.
 *
 * Never fails: every degradation warns and returns {@link skipped}, leaving the
 * catalogs exactly as they were.
 */
const processDep = (
	name: string,
	manifest: Manifest,
	catalogs: CatalogMap,
	owned: CatalogMap,
): Effect.Effect<
	DepOutcome,
	never,
	NpmRegistry | PackageTarball | LockfileReader | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const located = findDependency(manifest, name);
		if (located === null) {
			yield* Effect.logWarning(
				`CatalogConfigDeps: config dependency "${name}" is not declared in the root manifest, skipping`,
			);
			return skipped(catalogs);
		}

		const parsed = parseSpecifier(located.specifier);
		if (parsed === null) {
			yield* Effect.logWarning(
				`CatalogConfigDeps: config dependency "${name}" has a non-version specifier "${located.specifier}", skipping`,
			);
			return skipped(catalogs);
		}

		const registry = yield* NpmRegistry;
		const versions = yield* registry
			.versions(name)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));

		if (versions.length === 0) {
			yield* Effect.logWarning(`CatalogConfigDeps: could not query versions for "${name}", skipping`);
			return skipped(catalogs);
		}

		const next = yield* resolveLatestSatisfying(versions, resolutionRangeForSpecifier(parsed.prefix, parsed.version));
		if (next === null) {
			yield* Effect.logWarning(
				`CatalogConfigDeps: no published version of "${name}" satisfies "${located.specifier}", skipping`,
			);
			return skipped(catalogs);
		}

		const base = yield* resolveBaseVersion(name, parsed, versions);

		const nextOutcome = yield* fetchModuleCatalogs(name, next);
		if (nextOutcome._tag !== "Catalogs") {
			// fetchModuleCatalogs already warned with the reason. The range is not
			// bumped either: writing a version whose catalogs we could not merge would
			// leave the manifest describing a plugin release it never saw.
			yield* Effect.logWarning(
				`CatalogConfigDeps: could not read catalogs from ${name}@${next}, leaving it at ${located.specifier}`,
			);
			return skipped(catalogs);
		}
		const nextCatalogs = nextOutcome.catalogs;

		const baseOutcome = base === next ? nextOutcome : yield* fetchModuleCatalogs(name, base);

		// How a base failure is handled turns on WHY it failed, and collapsing the
		// three routes is a bug this code has already shipped: every reason used to
		// arrive as one `null` and take the plugin-wins path, so an integrity
		// mismatch on the base tarball silently discarded a user's override on a run
		// that reported success.
		//
		//   notFound         -> the base artifact is gone (yanked/unpublished). There
		//                       is genuinely no merge base, so plugin-wins is the
		//                       deliberate lossy-but-progressing choice.
		//   noCatalogsExport -> the base fetched and extracted fine and simply shipped
		//                       no catalogs. That is an EMPTY base, not a missing one:
		//                       every manifest entry in these catalogs predates us, so
		//                       a three-way merge against {} keeps them as the user's
		//                       and adds what the new version ships. Plugin-wins here
		//                       would overwrite a user's entry on a key the plugin has
		//                       only just started shipping.
		//   anything else    -> something that exists could not be read faithfully. We
		//                       do not know what is ours, so we change nothing.
		//
		// The final branch is deliberately a catch-all rather than an exhaustive
		// switch, so a reason ADDED upstream lands on the conservative route by
		// default. That has already happened once: `@effected/npm@0.12.0` split
		// `integrityUnverifiable` (the digest could not be computed) out of
		// `integrityMismatch` (two digests existed and differed), because the
		// former was being reported as a measured mismatch. It needed no change
		// here — a reason we do not recognise is exactly a base we cannot trust.
		let merged: CatalogMap;
		let deltas: ReadonlyArray<CatalogDelta>;

		if (baseOutcome._tag === "Catalogs") {
			({ merged, deltas } = threeWayMergeCatalogs(
				overlayOwned(baseOutcome.catalogs, owned, nextCatalogs),
				catalogs,
				nextCatalogs,
			));
		} else if (baseOutcome.reason === "notFound") {
			yield* Effect.logWarning(
				`CatalogConfigDeps: no published tarball for the installed ${name}@${base}; merging ${next} plugin-wins — its entries overwrite the manifest's, local additions survive, and nothing is removed`,
			);
			({ merged, deltas } = pluginWinsMerge(catalogs, nextCatalogs));
		} else if (baseOutcome.reason === "noCatalogsExport") {
			yield* Effect.logInfo(
				`CatalogConfigDeps: ${name}@${base} shipped no catalogs, so ${next} is a first adoption — merging against an empty base, which keeps every existing entry as the user's`,
			);
			({ merged, deltas } = threeWayMergeCatalogs(overlayOwned({}, owned, nextCatalogs), catalogs, nextCatalogs));
		} else {
			yield* Effect.logWarning(
				`CatalogConfigDeps: could not read catalogs from the installed ${name}@${base} (${baseOutcome.reason}), leaving ${name} at ${located.specifier} — merging without a trustworthy base could discard a local override`,
			);
			return skipped(catalogs);
		}

		const newSpecifier = `${parsed.prefix}${next}`;
		const update: DependencyUpdateResult | null =
			newSpecifier === located.specifier
				? null
				: {
						dependency: name,
						from: located.specifier,
						to: newSpecifier,
						// Reported as a config dependency so a bun run reads exactly like a
						// pnpm run in the PR body, commit subject and job summary.
						type: "config",
						package: null,
					};

		return {
			catalogs: merged,
			deltas,
			update,
			specifier: newSpecifier,
			field: located.field,
			contributed: nextCatalogs,
		};
	});

/**
 * Update every config dependency, in listed order, accumulating onto one
 * in-memory manifest that is written to disk once at the end.
 *
 * Listed order is load-bearing: two config dependencies shipping the same
 * catalog key both merge onto the same manifest, so the one listed last wins.
 */
const updateImpl = (
	deps: ReadonlyArray<string>,
	workspaceRoot: string,
): Effect.Effect<
	CatalogConfigDepsResult,
	FileSystemError,
	NpmRegistry | PackageTarball | LockfileReader | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (deps.length === 0) return { updates: [], deltas: [] };

		const pkgPath = join(workspaceRoot, "package.json");
		const raw = yield* Effect.try({
			try: () => readFileSync(pkgPath, "utf-8"),
			catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
		});
		const indent = detectIndent(raw);
		const manifest = yield* Effect.try({
			try: () => JSON.parse(raw) as Manifest,
			catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: `Invalid JSON: ${e}` }),
		});

		let catalogs = readManifestCatalogs(manifest);
		// Catalog entries written by config dependencies earlier in this run: they
		// are the action's, not a user's overrides, so a later dependency may
		// overwrite them (listed order decides a conflicting key).
		let owned: CatalogMap = {};
		const updates: Array<DependencyUpdateResult> = [];
		const deltas: Array<CatalogDelta> = [];
		let changed = false;

		for (const name of deps) {
			const outcome = yield* processDep(name, manifest, catalogs, owned);
			catalogs = outcome.catalogs;

			// A "kept" delta means a user override or addition survived the merge.
			// But when two config dependencies share a catalog, a key contributed by
			// an *earlier* dependency in this run is already on "disk" by the time a
			// later one's own base/next diff runs — and that later diff has no idea
			// the key is the action's own write, so it reads as a divergence from its
			// base and gets reported "kept". Drop any such phantom before it is ever
			// recorded: `owned` (as it stood before this dependency's own
			// contribution is folded in) is exactly the set of keys the action wrote
			// earlier in this run.
			const reportableDeltas = outcome.deltas.filter(
				(delta) => !(delta.action === "kept" && owned[delta.catalog]?.[delta.dependency] !== undefined),
			);
			owned = mergeCatalogMaps(owned, outcome.contributed);
			deltas.push(...reportableDeltas);

			if (outcome.update !== null && outcome.field !== null && outcome.specifier !== null) {
				(manifest[outcome.field] as Record<string, string>)[name] = outcome.specifier;
				updates.push(outcome.update);
				changed = true;
			}
			// A "kept" delta reports that a user override survived the merge — the
			// manifest is exactly as it was. Only added/updated/removed entries mean
			// the merge actually moved something, so only they warrant a rewrite (and,
			// downstream, a line in the PR body).
			if (outcome.deltas.some((delta) => delta.action !== "kept")) {
				changed = true;
			}
		}

		if (changed) {
			writeManifestCatalogs(manifest, catalogs);
			yield* Effect.try({
				try: () => writeFileSync(pkgPath, `${JSON.stringify(manifest, null, indent)}\n`, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "write", path: pkgPath, reason: String(e) }),
			});
			yield* Effect.logInfo(
				`Updated ${updates.length} config dependencies and ${deltas.length} catalog entries in ${pkgPath}`,
			);
		}

		return { updates, deltas };
	});
