/**
 * Build-time guard: the config-dependency module import must survive bundling as
 * a genuine runtime `import()`.
 *
 * `src/services/module-catalogs.ts` imports a config dependency's extracted
 * tarball entry from a path computed at runtime. Without the inline
 * `/* webpackIgnore: true *\/` magic comment, rspack compiles that call into a
 * context module (a build-time directory glob) and the action throws
 * `Cannot find module 'file:///…'` at runtime even though the file is on disk.
 *
 * That failure is invisible to vitest — it runs the TypeScript source, not the
 * bundle — and invisible to typecheck and lint. It only appears in the shipped
 * `dist/main.js`. So it is asserted here, against the built artifact, on every
 * build (`pnpm build`, `pnpm build:prod`, `pnpm ci:build` and CI's build step
 * all run `build:prod`, which invokes this script).
 *
 * The assertion anchors on the *call site*, not on any message near it: the two
 * statements
 *
 *   const entryUrl = pathToFileURL(join(packageDir, entry)).href;
 *   return await import(entryUrl);
 *
 * are adjacent in the source and stay adjacent in the bundle, minified or not.
 * (An earlier revision anchored on the warning string that reports the import's
 * failure. That is ~100 source lines away: adjacent once minified, but thousands
 * of characters away in an unminified `build:prod` bundle, where the guard then
 * failed a perfectly correct build.)
 *
 * With the comment, the bundled call site reads:
 *   …pathToFileURL(join(dir,entry)).href; return await import(t)
 * Without it, the same call site reads:
 *   …pathToFileURL(join(dir,entry)).href; return await l(5252)(t)
 * — a numbered webpack context module. The assertions below are exactly that
 * difference: at least one `pathToFileURL` in the bundle must be followed by a
 * native `import(<identifier>)`, and none may be followed by a context-module
 * call. (Other packages in the bundle call `pathToFileURL` without importing
 * anything; those windows simply match neither pattern.)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "main.js");

/**
 * A string emitted verbatim by module-catalogs.ts: proof it is still reachable.
 *
 * Kept to the stable half of the sentence deliberately. The full warning used to
 * be the anchor and broke this guard when the wording was reworded during the
 * effected#282 adoption — a build failure whose message named a missing module
 * rather than a changed string. The shorter the anchor, the fewer edits trip it
 * for no reason; it only has to be unique to this module.
 */
const ANCHOR = "fetchModuleCatalogs:";

/** The call site's first half — the runtime-computed URL the import consumes. */
const CALL_SITE = "pathToFileURL";

/** How far past a `pathToFileURL` the import that consumes it may sit. */
const WINDOW = 400;

/**
 * A genuine dynamic import of a runtime-computed identifier: `import(t)`, or
 * `import(/* webpackIgnore: true *\/ entryUrl)` when the build does not minify
 * (rspack preserves the magic comment it acted on).
 */
const NATIVE_IMPORT = /await import\(\s*(?:\/\*[^*]*\*\/\s*)?[A-Za-z_$][\w$]*\s*\)/;

/** rspack's context-module rewrite: `await l(5252)(t)` / `__webpack_require__.t(`. */
const CONTEXT_MODULE = /await\s+[A-Za-z_$][\w$.]*\(\s*\d+\s*\)\(|__webpack_require__\.t\(|webpackContext/;

const fail = (message) => {
	console.error(`assert-native-dynamic-import: ${message}`);
	process.exit(1);
};

const bundle = readFileSync(BUNDLE, "utf-8");

if (!bundle.includes(ANCHOR)) {
	fail(
		`could not find module-catalogs in ${BUNDLE} (anchor string "${ANCHOR}" is absent).\n` +
			"If the warning text in src/services/module-catalogs.ts changed, update ANCHOR in this script. " +
			"If module-catalogs is no longer reachable from the main entry, drop this guard.",
	);
}

/** Every `pathToFileURL(...)` in the bundle, with the code that immediately follows it. */
const windows = [];
for (let at = bundle.indexOf(CALL_SITE); at !== -1; at = bundle.indexOf(CALL_SITE, at + 1)) {
	windows.push(bundle.slice(at, at + WINDOW));
}

if (!windows.some((w) => NATIVE_IMPORT.test(w))) {
	fail(
		`the dynamic import in src/services/module-catalogs.ts did not survive bundling as a native import() in ${BUNDLE}.\n` +
			"rspack has rewritten it (most likely into a context module), which throws \"Cannot find module 'file:///…'\" at runtime. " +
			"Restore the /* webpackIgnore: true */ magic comment inside the import() parentheses.",
	);
}

if (windows.some((w) => CONTEXT_MODULE.test(w))) {
	fail(
		`a pathToFileURL import was compiled into a webpack context module in ${BUNDLE}.\n` +
			"Restore the /* webpackIgnore: true */ magic comment inside the import() parentheses.",
	);
}

console.log("assert-native-dynamic-import: dist/main.js keeps a native dynamic import for module-catalogs.");
