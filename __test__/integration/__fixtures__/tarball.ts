/**
 * Shared test fixture: build a real npm-shaped tarball on disk.
 *
 * `fetchModuleCatalogs` (Task 5) downloads and extracts a config dependency's
 * exact published tarball, so its tests need a real gzipped tar to extract
 * rather than a mock of the extraction step. Task 6's `CatalogConfigDeps`
 * test drives the same fetch path end-to-end, so this builder lives here as
 * a shared module rather than duplicated (or inlined) in either test file.
 *
 * @module services/__fixtures__/tarball
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build a real npm-shaped tarball: a gzipped tar whose single top-level entry is
 * `package/`, holding a manifest and an `index.js` with the given source. This is
 * exactly what a registry serves, so the code under test exercises its real
 * extract-and-import path rather than a mock of it.
 *
 * `exportsField` overrides the manifest's `exports` — every legal shape (the
 * `{ ".": … }` subpath map, the `"./index.js"` string shorthand, a root
 * conditions object) resolves to the same `index.js`, so entry-point resolution
 * can be exercised end-to-end through a real extract-and-import rather than only
 * against plain objects. Pass `null` for a manifest with **no** `exports` field
 * at all: a JS default parameter substitutes on an explicit `undefined` just as
 * it does on an omitted argument, so `undefined` cannot express that case.
 *
 * @returns the path of the built `.tgz`.
 */
export const makeTarball = (
	workDir: string,
	version: string,
	indexSource: string,
	exportsField: unknown = { ".": "./index.js" },
): string => {
	const stage = join(workDir, `stage-${version}`);
	mkdirSync(join(stage, "package"), { recursive: true });
	writeFileSync(
		join(stage, "package", "package.json"),
		// `exports: undefined` is dropped by JSON.stringify, which is exactly the
		// "no exports field" manifest the `null` sentinel asks for.
		JSON.stringify({
			name: "@fixture/plugin",
			version,
			type: "module",
			exports: exportsField === null ? undefined : exportsField,
		}),
	);
	writeFileSync(join(stage, "package", "index.js"), indexSource);
	const out = join(workDir, `plugin-${version}.tgz`);
	execFileSync("tar", ["-czf", out, "-C", stage, "package"]);
	return out;
};
