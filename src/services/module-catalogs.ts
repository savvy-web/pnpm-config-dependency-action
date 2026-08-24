/**
 * ModuleCatalogs - read a config dependency's `catalogs` export from its
 * published tarball.
 *
 * A config dependency ships a map of catalogs as a named (or default) export.
 * pnpm's own config-dependency mechanism reads this out of the installed
 * package, but the catalog merge in this action has to happen *before* any
 * install runs (its output feeds the manifest that install then reads).
 * `fetchModuleCatalogs` closes that gap.
 *
 * Fetching, integrity-verifying and extracting the tarball is
 * `@effected/npm`'s `PackageTarball`; resolving the extracted package's entry
 * point is `@effected/package-json`'s `resolveEntryPoint`. Both were harvested
 * out of this module (effected#282). What stays here is the half that is
 * genuinely ours: loading the entry with `import()`, and deciding what a
 * missing or malformed `catalogs` export means.
 *
 * This is a standalone exported function (like `syncPeers`), not a
 * `Context.Tag` service — it has no state and one caller.
 *
 * @module services/module-catalogs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PublishedVersion, TarballError } from "@effected/npm";
import { NpmRegistry, PackageTarball } from "@effected/npm";
import { resolveEntryPoint } from "@effected/package-json";
import { Effect, Option, Result } from "effect";
import type { CatalogMap } from "../utils/catalogs.js";
import { normalizeCatalogs } from "../utils/catalogs.js";

/**
 * Why a config dependency's catalogs could not be read.
 *
 * The first four members are `TarballError`'s own reasons, carried through
 * verbatim rather than re-spelled, so the vocabulary this module reports is
 * the vocabulary the kit raises. The rest are this module's own stages, which
 * begin after `PackageTarball.extract` has handed back a directory.
 *
 * **The discrimination is load-bearing and was added to fix a live bug.** Every
 * one of these used to collapse into a single `null`, and `CatalogConfigDeps`
 * read that `null` on the *base* version as "there is no merge base", which
 * silently downgraded the merge to the lossy plugin-wins algorithm. An
 * integrity mismatch therefore discarded a user's catalog override on a run
 * that reported success. See {@link ModuleCatalogs} and the routing in
 * `catalog-config-deps.ts`.
 */
export type ModuleCatalogsUnavailableReason =
	| TarballError["reason"]
	| "unresolvedEntryPoint"
	| "notImportable"
	| "noCatalogsExport"
	| "malformedCatalogs";

/** The outcome of reading one published version's `catalogs` export. */
export type ModuleCatalogs =
	| { readonly _tag: "Catalogs"; readonly catalogs: CatalogMap }
	| { readonly _tag: "Unavailable"; readonly reason: ModuleCatalogsUnavailableReason };

const catalogsFound = (catalogs: CatalogMap): ModuleCatalogs => ({ _tag: "Catalogs", catalogs });
const unavailable = (reason: ModuleCatalogsUnavailableReason): ModuleCatalogs => ({ _tag: "Unavailable", reason });

/**
 * Read the manifest, resolve its entry point, and import it off disk.
 *
 * The read/parse/import sequence is wrapped so every way it can fail — a
 * missing or unparsable `package.json`, a missing entry file, a syntax error,
 * or (the self-containment constraint) a plugin whose entry imports a runtime
 * dependency that isn't there because a bare extracted tarball has no
 * `node_modules` — collapses into `notImportable`. Entry *resolution* failing
 * is reported separately as `unresolvedEntryPoint`, because that one is a
 * statement about the consumer's manifest rather than about our load.
 *
 * The `import()` argument is a path computed at runtime from the extracted
 * tarball, so it carries a `webpackIgnore` magic comment: without it rspack
 * would compile this call into a context module (a build-time directory glob)
 * and throw `Cannot find module 'file:///…'` in production even though the
 * file exists on disk — the same failure `build.nativeDynamicImports` guards
 * against for third-party packages in `action.config.ts`. That option only
 * matches paths under `node_modules`, so it cannot cover this first-party
 * call site; the magic comment is the direct fix rspack (like webpack)
 * recognizes for any `import(expr)`, first-party or not.
 *
 * This loader deliberately did **not** move upstream with the rest: a
 * kit-level `import()` of a computed path would hand every bundling consumer
 * the context-module problem with no seam to fix it.
 */
const importPackageEntry = (packageDir: string, entry: string): Effect.Effect<Record<string, unknown>, unknown> =>
	Effect.tryPromise({
		try: async () => {
			const entryUrl = pathToFileURL(join(packageDir, entry)).href;
			return (await import(/* webpackIgnore: true */ entryUrl)) as Record<string, unknown>;
		},
		catch: (error) => error,
	});

/** Read and parse the extracted package's own manifest. */
const readExtractedManifest = (packageDir: string): Effect.Effect<Record<string, unknown>, unknown> =>
	Effect.try({
		try: () => JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as Record<string, unknown>,
		catch: (error) => error,
	});

/**
 * Fetch, extract, and import a config dependency's exact published version to
 * read its `catalogs` export.
 *
 * Never fails: every failure path is logged as a warning naming the package,
 * the version and the reason, and yields an `Unavailable` outcome carrying
 * that reason. A config dependency that does not ship catalogs is not fatal to
 * the run — but *which* failure occurred is the caller's business, so the
 * reason is returned rather than collapsed.
 */
export const fetchModuleCatalogs = (
	pkg: string,
	version: string,
): Effect.Effect<ModuleCatalogs, never, NpmRegistry | PackageTarball> =>
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;
		const tarball = yield* PackageTarball;

		const queried = yield* Effect.result(registry.version(pkg, version));
		if (Result.isFailure(queried)) {
			yield* Effect.logWarning(
				`fetchModuleCatalogs: could not query the registry for ${pkg}@${version}, skipping: ${String(queried.failure)}`,
			);
			return unavailable("http");
		}

		const info: PublishedVersion | undefined = Option.getOrUndefined(queried.success);
		if (info === undefined) {
			yield* Effect.logWarning(`fetchModuleCatalogs: the registry has no published ${pkg}@${version}, skipping`);
			return unavailable("notFound");
		}

		// `extract` is scoped: the temp directory is removed when this scope
		// closes, so nothing here owns the cleanup.
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const extracted = yield* Effect.result(tarball.extract(info));
				if (Result.isFailure(extracted)) {
					const error = extracted.failure;
					yield* Effect.logWarning(`fetchModuleCatalogs: ${error.message}, skipping`);
					return unavailable(error.reason);
				}

				const packageDir = extracted.success;

				const manifest = yield* Effect.result(readExtractedManifest(packageDir));
				if (Result.isFailure(manifest)) {
					yield* Effect.logWarning(
						`fetchModuleCatalogs: could not read the manifest of ${pkg}@${version}, skipping: ${String(manifest.failure)}`,
					);
					return unavailable("notImportable");
				}

				// This action always loads the entry with `import()`, so the default
				// ["import", "default"] condition order is the correct policy here.
				const entry = resolveEntryPoint(manifest.success);
				if (Result.isFailure(entry)) {
					yield* Effect.logWarning(
						`fetchModuleCatalogs: ${pkg}@${version} resolves no root entry point (${entry.failure.reason}), skipping`,
					);
					return unavailable("unresolvedEntryPoint");
				}

				const mod = yield* Effect.result(importPackageEntry(packageDir, entry.success));
				if (Result.isFailure(mod)) {
					yield* Effect.logWarning(
						`fetchModuleCatalogs: could not import the entry module of ${pkg}@${version}, skipping: ${String(mod.failure)}`,
					);
					return unavailable("notImportable");
				}

				// The named `catalogs` export wins when present (even if malformed —
				// normalizeCatalogs below is the single source of truth for shape
				// validation); otherwise fall back to the default export.
				const rawCatalogs = "catalogs" in mod.success ? mod.success.catalogs : mod.success.default;

				if (rawCatalogs === undefined) {
					yield* Effect.logWarning(`fetchModuleCatalogs: ${pkg}@${version} has no catalogs export, skipping`);
					return unavailable("noCatalogsExport");
				}

				const catalogs = normalizeCatalogs(rawCatalogs);
				if (catalogs === null) {
					yield* Effect.logWarning(`fetchModuleCatalogs: ${pkg}@${version} has a malformed catalogs export, skipping`);
					return unavailable("malformedCatalogs");
				}

				return catalogsFound(catalogs);
			}),
		);
	});
