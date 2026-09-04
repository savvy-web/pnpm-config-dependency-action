import { defineConfig } from "@savvy-web/github-action-builder";

export default defineConfig({
	entries: {
		pre: "src/pre.ts",
		main: "src/main.ts",
		post: "src/post.ts",
	},
	build: {
		minify: true,
		// Packages that perform a fully dynamic `await import(expr)` at
		// runtime. Without this, rspack compiles the import into a context
		// module and the action throws `Cannot find module 'file:///…'` in
		// production even though the file exists.
		// `@changesets/apply-release-plan` loads the configured changelog
		// module this way (via silk-effects' embedded changesets v3 engine,
		// introduced at silk-effects 3.0.0 and unchanged in the majors since —
		// confirmed still present and still fully dynamic at the currently
		// installed `@changesets/apply-release-plan@8.0.0`).
		//
		// `@effected/workspaces`'s ConfigDependencyHooks loader has the same
		// computed `import(candidateUrl)` pattern and is reachable here via
		// WorkspaceCatalogs. It does NOT need listing: as of
		// `@effected/workspaces@0.13.0` it carries its own inline
		// `/* webpackIgnore: true */` (upstream spencerbeggs/effected#242), so
		// rspack leaves the import native and emits no warning — re-verified
		// still present at the installed version. Listing it here
		// would still fail the build — the builder's ignore loader throws on that
		// file — so if a "Critical dependency" warning naming
		// `ConfigDependencyHooks.js` ever returns, the fix is upstream, not an
		// entry in this list.
		//
		// A third, different case: `src/services/module-catalogs.ts`
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
		// Canon B6 says enabled — a committed `.github/actions/local` is the
		// act/CI smoke target. This repo deliberately diverges: the action is
		// fetched by every consumer on every run, and a committed local copy
		// roughly doubles the download weight (measured: persisting main+pre+post
		// added ~2.0 MB alongside the ~2.0 MB already in dist/) for a local `act`
		// loop nobody here exercises. The act scaffolding was removed rather than
		// fed — do not re-enable this without a real consumer of the output.
		enabled: false,
		path: ".github/actions/local",
	},
});
