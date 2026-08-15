import { defineConfig } from "@savvy-web/github-action-builder";

export default defineConfig({
	entries: {
		pre: "src/pre.ts",
		main: "src/main.ts",
		post: "src/post.ts",
	},
	build: {
		minify: true,
		// `@cyclonedx/cyclonedx-library` (pulled in transitively by
		// `@savvy-web/github-action-effects`) ships optional plugins — XML
		// serializers/validators and draft-2019 JSON validators — that this
		// action never invokes. They aren't installed and would never be
		// present in the deployed action, so `ignore` (alias to a throwing
		// stub) is correct here, not `externals` (which means "available at
		// runtime"). cyclonedx's `_optPlug` wrapper try/catches the stub throw
		// and falls through gracefully.
		ignore: ["xmlbuilder2", "libxmljs2", "ajv-formats-draft2019"],
		// Packages that perform a fully dynamic `await import(expr)` at
		// runtime. Without this, rspack compiles the import into a context
		// module and the action throws `Cannot find module 'file:///…'` in
		// production even though the file exists.
		// `@changesets/apply-release-plan` loads the configured changelog
		// module this way (via silk-effects 3's changesets v3 engine).
		//
		// `@effected/workspaces`'s ConfigDependencyHooks loader has the same
		// computed `import(candidateUrl)` pattern and is reachable here via
		// WorkspaceCatalogs. It does NOT need listing: as of
		// `@effected/workspaces@0.13.0` it carries its own inline
		// `/* webpackIgnore: true */` (upstream spencerbeggs/effected#242), so
		// rspack leaves the import native and emits no warning. Listing it here
		// would still fail the build — the builder's ignore loader throws on that
		// file — so if a "Critical dependency" warning naming
		// `ConfigDependencyHooks.js` ever returns, the fix is upstream, not an
		// entry in this list.
		//
		// A third, different case: `src/services/module-catalogs.ts` (Task 5)
		// dynamically imports a config dependency's extracted tarball entry —
		// a path computed at runtime from a temp directory, not a package
		// specifier. This option's rule-building only matches resolved paths
		// under `node_modules/<name>/` (see `services/native-dynamic-imports.ts`
		// in the builder), so it structurally cannot target first-party source
		// under `src/`. That call site instead carries its own inline
		// `/* webpackIgnore: true */` magic comment ahead of the `import(...)`
		// call — the same fix this loader injects for the packages listed
		// above, just written directly since there's no third-party module
		// path to match against here. `module-catalogs.ts` is reachable from
		// `dist/main.js` (via `CatalogConfigDeps`), and because a context-module
		// rewrite only fails in production — vitest runs the source, not the
		// bundle — `build:prod` runs `scripts/assert-native-dynamic-import.mjs`
		// after every build, asserting the built `dist/main.js` still holds a
		// genuine `await import(<ident>)` at that call site and not a numbered
		// context module. Deleting the magic comment fails the build.
		nativeDynamicImports: ["@changesets/apply-release-plan"],
	},
	persistLocal: {
		enabled: false,
		path: ".github/actions/local",
	},
});
