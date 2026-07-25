/**
 * ModuleCatalogs - read a config dependency's `catalogs` export from its
 * published tarball.
 *
 * A config dependency ships a map of catalogs as a named (or default) export.
 * pnpm's own config-dependency mechanism reads this out of the installed
 * package, but the catalog merge in this action has to happen *before* any
 * install runs (its output feeds the manifest that install then reads).
 * `fetchModuleCatalogs` closes that gap: it downloads the exact version being
 * written into the manifest, extracts the tarball with `tar` (present on
 * every GitHub runner image, so this needs no new dependency), and imports
 * the extracted `index.js` directly off disk — self-contained, no
 * `node_modules` required.
 *
 * This is a standalone exported function (like `syncPeers`), not a
 * `Context.Tag` service — it has no state and one caller.
 *
 * @module services/module-catalogs
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Run } from "@effected/commands";
import type { PublishedVersion } from "@effected/npm";
import { NpmRegistry } from "@effected/npm";
import { Effect, Option } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";
import type { CatalogMap } from "../utils/catalogs.js";
import { normalizeCatalogs } from "../utils/catalogs.js";

/**
 * Resolve a conditional-exports object to a file, preferring `import` over
 * `default` — this action always loads the entry with `import()`, so the ESM
 * condition is the one that will actually be evaluated.
 *
 * Returns `null` for an object carrying neither condition (e.g. a
 * `require`-only package), so the caller can fall through to `main`.
 */
const resolveConditions = (conditions: Record<string, unknown>): string | null => {
	if (typeof conditions.import === "string") {
		return conditions.import;
	}
	if (typeof conditions.default === "string") {
		return conditions.default;
	}
	return null;
};

/**
 * Is this root `exports` object a conditions map rather than a subpath map?
 *
 * Node's rule: the two forms cannot be mixed, and a subpath map is identified
 * by its keys starting with `"."`. So an object with no `"."`-prefixed key is
 * conditions-only sugar for the `"."` subpath (`{ "import": "./x.js" }` ==
 * `{ ".": { "import": "./x.js" } }`). An empty object is neither — it exports
 * nothing — and is treated as not-conditions so resolution falls through to
 * `main`.
 */
const isRootConditions = (exportsObject: Record<string, unknown>): boolean => {
	const keys = Object.keys(exportsObject);
	return keys.length > 0 && !keys.some((key) => key.startsWith("."));
};

/**
 * Resolve the entry file for an extracted package from its manifest's
 * `exports` field, falling back to `main` and then to `index.js` when the
 * manifest has no usable `exports`.
 *
 * All three legal `exports` shapes are honored, because all three appear in
 * real published packages and a config dependency whose entry cannot be found
 * silently ships no catalogs at all:
 * - **String shorthand** — `"exports": "./index.js"`, sugar for `{ ".": "./index.js" }`.
 * - **Subpath map** — `{ ".": "./index.js" }`, or `{ ".": { import, default } }`.
 * - **Root conditions** — `{ "import": "./index.js", "default": "./index.cjs" }`,
 *   conditions at the root with no `"."` key (see `isRootConditions`).
 *
 * Exported (like `computePeerRange`) so entry resolution can be unit tested
 * directly against plain manifest objects, without needing a tarball for
 * every shape.
 */
export const resolveEntryPoint = (manifest: Record<string, unknown>): string => {
	const exportsField = manifest.exports;

	// String shorthand: `"exports": "./index.js"`.
	if (typeof exportsField === "string") {
		return exportsField;
	}

	if (typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)) {
		const exportsObject = exportsField as Record<string, unknown>;

		// Root conditions, with no "." subpath key.
		if (isRootConditions(exportsObject)) {
			const resolved = resolveConditions(exportsObject);
			if (resolved !== null) {
				return resolved;
			}
		} else {
			const dot = exportsObject["."];
			if (typeof dot === "string") {
				return dot;
			}
			if (typeof dot === "object" && dot !== null && !Array.isArray(dot)) {
				const resolved = resolveConditions(dot as Record<string, unknown>);
				if (resolved !== null) {
					return resolved;
				}
			}
		}
	}

	if (typeof manifest.main === "string") {
		return manifest.main;
	}
	return "index.js";
};

/**
 * Read the manifest, resolve its entry point, and import it off disk.
 *
 * A single `Effect.tryPromise` wraps the read/parse/resolve/import sequence
 * so every way it can fail — a missing or unparsable `package.json`, a
 * missing entry file, a syntax error, or (the self-containment constraint) a
 * plugin whose entry imports a runtime dependency that isn't there because a
 * bare extracted tarball has no `node_modules` — collapses into the same
 * "no importable entry" outcome for the caller.
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
 */
const importPackageEntry = (packageDir: string): Effect.Effect<Record<string, unknown>, unknown> =>
	Effect.tryPromise({
		try: async () => {
			const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as Record<string, unknown>;
			const entry = resolveEntryPoint(manifest);
			const entryUrl = pathToFileURL(join(packageDir, entry)).href;
			return (await import(/* webpackIgnore: true */ entryUrl)) as Record<string, unknown>;
		},
		catch: (error) => error,
	});

/**
 * Download, extract, and import a package version to read its `catalogs`
 * value, given an already-resolved tarball URL and a fresh temp directory.
 *
 * `integrity` is the registry's `sha512-<base64>` digest for this exact
 * version (when published), verified against the downloaded bytes BEFORE
 * extraction/import — a poisoned intermediary (CDN edge, proxy, mirror)
 * serving different bytes than the registry vouched for must never reach
 * `tar` or `import()`. `integrity` is optional (see `NpmPackageInfo` in
 * `@savvy-web/github-action-effects`); when absent the download proceeds
 * unverified, same as the rest of this best-effort pipeline (mirrors
 * `PnpmUpgrade`'s bare-version fallback when integrity is unavailable).
 */
const readCatalogsFromTarball = (
	pkg: string,
	version: string,
	tarballUrl: string,
	integrity: string | undefined,
	dir: string,
	http: HttpClient.HttpClient,
): Effect.Effect<CatalogMap | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const response = yield* http.get(tarballUrl).pipe(Effect.catch(() => Effect.succeed(null)));

		if (response === null) {
			yield* Effect.logWarning(`fetchModuleCatalogs: failed to download tarball for ${pkg}@${version}, skipping`);
			return null;
		}

		// A non-2xx status (e.g. a 404 or 5xx) must be caught here — piping it
		// straight to disk would instead surface as a misleading "failed to
		// extract tarball" warning once `tar` chokes on the error-page body.
		const statusOk = Math.floor(response.status / 100) === 2;
		if (!statusOk) {
			yield* Effect.logWarning(
				`fetchModuleCatalogs: failed to download tarball for ${pkg}@${version}, HTTP ${response.status}, skipping`,
			);
			return null;
		}

		const buffer = yield* response.arrayBuffer.pipe(
			Effect.map((data) => Buffer.from(data)),
			Effect.catch(() => Effect.succeed(null)),
		);

		if (buffer === null) {
			yield* Effect.logWarning(`fetchModuleCatalogs: failed to download tarball for ${pkg}@${version}, skipping`);
			return null;
		}

		if (integrity === undefined) {
			yield* Effect.logDebug(
				`fetchModuleCatalogs: no published integrity for ${pkg}@${version}, skipping tarball verification`,
			);
		} else {
			const actualIntegrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
			if (actualIntegrity !== integrity) {
				yield* Effect.logWarning(
					`fetchModuleCatalogs: tarball integrity mismatch for ${pkg}@${version} (expected ${integrity}, got ${actualIntegrity}), skipping`,
				);
				return null;
			}
		}

		const tarballPath = join(dir, "package.tgz");
		const written = yield* Effect.try({
			try: () => writeFileSync(tarballPath, buffer),
			catch: (error) => error,
		}).pipe(
			Effect.as(true),
			Effect.catch((error) =>
				Effect.logWarning(
					`fetchModuleCatalogs: failed to write tarball for ${pkg}@${version} to disk, skipping: ${String(error)}`,
				).pipe(Effect.as(false)),
			),
		);

		if (!written) {
			return null;
		}

		// Run.succeeds collapses a non-zero exit AND a spawn failure to `false`,
		// which is exactly this best-effort pipeline's contract.
		const extracted = yield* Run.succeeds(ChildProcess.make("tar", ["-xzf", tarballPath, "-C", dir]));

		if (!extracted) {
			yield* Effect.logWarning(`fetchModuleCatalogs: failed to extract tarball for ${pkg}@${version}, skipping`);
			return null;
		}

		const mod = yield* importPackageEntry(join(dir, "package")).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					`fetchModuleCatalogs: could not import an entry module for ${pkg}@${version}, skipping: ${String(error)}`,
				).pipe(Effect.as(null)),
			),
		);

		if (mod === null) {
			return null;
		}

		// The named `catalogs` export wins when present (even if malformed —
		// normalizeCatalogs below is the single source of truth for shape
		// validation); otherwise fall back to the default export.
		const rawCatalogs = "catalogs" in mod ? mod.catalogs : mod.default;

		if (rawCatalogs === undefined) {
			yield* Effect.logWarning(`fetchModuleCatalogs: ${pkg}@${version} has no catalogs export, skipping`);
			return null;
		}

		const catalogs = normalizeCatalogs(rawCatalogs);
		if (catalogs === null) {
			yield* Effect.logWarning(`fetchModuleCatalogs: ${pkg}@${version} has a malformed catalogs export, skipping`);
			return null;
		}

		return catalogs;
	});

/**
 * Fetch, extract, and import a config dependency's exact published version to
 * read its `catalogs` export.
 *
 * Never fails: every failure path (no tarball URL, HTTP failure, extraction
 * failure, no importable entry, no `catalogs` export, or a non-conforming
 * shape) is logged as a warning naming the package and version, and yields
 * `null` — a config dependency that does not ship catalogs is skipped, not
 * fatal to the run.
 */
export const fetchModuleCatalogs = (
	pkg: string,
	version: string,
): Effect.Effect<
	CatalogMap | null,
	never,
	NpmRegistry | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;

		const found = yield* registry
			.version(pkg, version)
			.pipe(Effect.catch(() => Effect.succeed(Option.none<PublishedVersion>())));
		const info = Option.getOrUndefined(found);

		if (info?.tarball === undefined) {
			yield* Effect.logWarning(`fetchModuleCatalogs: ${pkg}@${version} has no published tarball URL, skipping`);
			return null;
		}

		const http = yield* HttpClient.HttpClient;

		const dir = yield* Effect.try({
			try: () => mkdtempSync(join(tmpdir(), "silk-cfgdep-")),
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					`fetchModuleCatalogs: failed to create a temp directory for ${pkg}@${version}, skipping: ${String(error)}`,
				).pipe(Effect.as(null)),
			),
		);

		if (dir === null) {
			return null;
		}

		return yield* readCatalogsFromTarball(pkg, version, info.tarball, info.integrity, dir, http).pipe(
			Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
		);
	});
