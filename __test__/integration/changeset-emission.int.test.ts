/**
 * Integration canaries for the DepsRegen-backed changeset step.
 *
 * These drive the action's `Changesets` service through the REAL
 * `@savvy-web/silk-effects` `Changesets.DepsRegenDefault` layer (the same
 * batteries-included layer `makeAppLayer` wires) against a throwaway git repo.
 * They pin, from the consumer side:
 *
 *  1. a publishable (publishConfig/silk, non-versionPrivate) package emits a
 *     changeset through the default layer — the exact path the upstream
 *     "pass the project root to listPublishablePackageNames" fix restored;
 *  2. accumulated pure-dependency changesets for one package consolidate to a
 *     single current table on re-fire (the dedup the whole adoption is for);
 *  3. a catalog-only bump (manifest specifier unchanged) still surfaces a row
 *     with concrete versions (upstream catalog-aware diffing);
 *  4. a non-versionable package is gated out;
 *  5. markdown-significant characters in a cell survive the table writer
 *     verbatim — the regression canary for the `\~` corruption.
 *
 * The exhaustive gating matrix (silk vs vanilla mode, publish targets, ignore,
 * versionPrivate) lives in `@savvy-web/silk-effects`' own DepsRegen tests; here
 * we only prove the action's wiring + consolidation + catalog-awareness.
 *
 * DepsRegen reads git history (`PointInTimeWorkspace.at`) and the working tree,
 * so each scenario commits a base state on `main`, mutates the worktree, then
 * regenerates against `base = "main"`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { Changesets, ChangesetsLive } from "../../src/services/changesets.js";
import { silentLogger } from "../utils/fixtures.js";

// makeAppLayer wires `SilkChangesets.DepsRegenDefault`, which is bound to
// `process.cwd()` at layer-build time (correct in production, where the action
// runs at the workspace root). These integration tests run against per-test
// throwaway git repos, so the layer must be built bound to each temp repo via
// `makeDepsRegenDefault({ cwd })` — the same root-binding discipline
// @effected/workspaces requires (root is fixed at build, not passed per call).
const changesetsLayerFor = (root: string) =>
	ChangesetsLive.pipe(
		Layer.provide(SilkChangesets.makeDepsRegenDefault({ cwd: root }).pipe(Layer.provide(NodeServices.layer))),
	);

const git = (cwd: string, ...args: string[]): void => {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
};

const writeJson = (path: string, value: unknown): void => {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
};

/** Emitted changesets = `.changeset/*.md` minus README.md. */
const emitted = (root: string): ReadonlyArray<{ readonly name: string; readonly content: string }> => {
	const dir = join(root, ".changeset");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.map((f) => ({ name: f, content: readFileSync(join(dir, f), "utf-8") }));
};

/** A single-package pure-dependency changeset body (matches isPureDependencyChangeset). */
const pureDepChangeset = (pkg: string, dep: string, from: string, to: string): string =>
	`---\n"${pkg}": patch\n---\n\n## Dependencies\n\n` +
	"| Dependency | Type | Action | From | To |\n| :--- | :--- | :--- | :--- | :--- |\n" +
	`| ${dep} | dependency | updated | ${from} | ${to} |\n`;

interface RepoOptions {
	/** Leaf package.json (committed as the base state). */
	readonly leaf: Record<string, unknown>;
	/** Root pnpm-workspace.yaml contents. */
	readonly workspaceYaml: string;
	/** Extra files to write+commit at base, keyed by repo-relative path. */
	readonly baseFiles?: Record<string, string>;
}

/**
 * git-init a monorepo with a `main` base commit: root package.json,
 * pnpm-workspace.yaml, silk `.changeset/config.json`, and one leaf package.
 */
const setupRepo = (root: string, options: RepoOptions): void => {
	mkdirSync(join(root, "packages", "leaf"), { recursive: true });
	mkdirSync(join(root, ".changeset"), { recursive: true });

	writeJson(join(root, "package.json"), { name: "canary-root", version: "0.0.0", private: true });
	writeFileSync(join(root, "pnpm-workspace.yaml"), options.workspaceYaml);
	writeJson(join(root, ".changeset", "config.json"), {
		changelog: ["@savvy-web/silk/changesets/changelog", { repo: "test/test" }],
		commit: false,
		access: "public",
		baseBranch: "main",
		updateInternalDependencies: "patch",
		ignore: [],
	});
	writeJson(join(root, "packages", "leaf", "package.json"), options.leaf);
	for (const [rel, content] of Object.entries(options.baseFiles ?? {})) {
		writeFileSync(join(root, rel), content);
	}

	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "canary@test.local");
	git(root, "config", "user.name", "Canary");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "add", "-A");
	git(root, "commit", "-m", "base");
};

const run = (root: string): Promise<ReadonlyArray<{ id: string; packages: readonly string[] }>> =>
	Effect.runPromise(
		Effect.flatMap(Changesets, (c) => c.create(root, "main")).pipe(
			Effect.provide(changesetsLayerFor(root)),
			Effect.provide(silentLogger),
		),
	) as Promise<ReadonlyArray<{ id: string; packages: readonly string[] }>>;

const WS_LEAF = "packages:\n  - packages/leaf\n";

describe("changeset emission integration (DepsRegenDefault)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cs-int-"));
	});

	it("publishable target: prod-dep bump emits one changeset through the default layer", async () => {
		setupRepo(root, {
			workspaceYaml: WS_LEAF,
			leaf: { name: "@scope/leaf", version: "0.1.0", private: false, dependencies: { effect: "3.0.0" } },
		});
		// Worktree change: bump the declared dependency (uncommitted).
		writeJson(join(root, "packages", "leaf", "package.json"), {
			name: "@scope/leaf",
			version: "0.1.0",
			private: false,
			dependencies: { effect: "3.2.0" },
		});

		const result = await run(root);
		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual(["@scope/leaf"]);
		const files = emitted(root);
		expect(files).toHaveLength(1);
		expect(files[0].content).toContain('"@scope/leaf": patch');
		expect(files[0].content).toContain("effect");
		expect(files[0].content).toContain("3.2.0");
	});

	it("consolidates accumulated pure-dependency changesets to one on re-fire", async () => {
		setupRepo(root, {
			workspaceYaml: WS_LEAF,
			leaf: { name: "@scope/leaf", version: "0.1.0", private: false, dependencies: { effect: "3.0.0" } },
		});
		writeJson(join(root, "packages", "leaf", "package.json"), {
			name: "@scope/leaf",
			version: "0.1.0",
			private: false,
			dependencies: { effect: "3.2.0" },
		});
		// Two accumulated pure-dep changesets for the same package (from prior runs).
		writeFileSync(join(root, ".changeset", "old-one.md"), pureDepChangeset("@scope/leaf", "effect", "3.0.0", "3.1.0"));
		writeFileSync(join(root, ".changeset", "old-two.md"), pureDepChangeset("@scope/leaf", "effect", "3.1.0", "3.2.0"));

		await run(root);
		const files = emitted(root);
		// The two stale pure-dep changesets are deleted; exactly one fresh table remains.
		expect(files).toHaveLength(1);
		expect(files.map((f) => f.name)).not.toContain("old-one.md");
		expect(files.map((f) => f.name)).not.toContain("old-two.md");
		expect(files[0].content).toContain('"@scope/leaf": patch');
	});

	it("catalog-only bump surfaces a row with concrete versions", async () => {
		setupRepo(root, {
			workspaceYaml: `${WS_LEAF}catalog:\n  effect: 3.0.0\n`,
			leaf: { name: "@scope/leaf", version: "0.1.0", private: false, dependencies: { effect: "catalog:" } },
		});
		// Manifest specifier stays `catalog:`; only the inline catalog version moves.
		writeFileSync(join(root, "pnpm-workspace.yaml"), `${WS_LEAF}catalog:\n  effect: 3.2.0\n`);

		const result = await run(root);
		expect(result).toHaveLength(1);
		const files = emitted(root);
		expect(files[0].content).toContain("effect");
		expect(files[0].content).toContain("3.0.0");
		expect(files[0].content).toContain("3.2.0");
	});

	// Regression canary. The emitted table used to run through a bare
	// remark-gfm/remark-stringify pipeline, which escapes anything that could open
	// a markdown construct: `~` (GFM strikethrough) became `\~` and `_` (emphasis)
	// became `\_`. That shipped — spencerbeggs/runtime-resolver's changeset at
	// commit 5110424 carried `\~0.2.0` / `\~0.2.1` and had to be hand-fixed. The
	// existing scenarios above all use plain `N.N.N` specifiers and stayed green
	// throughout, which is exactly why this reached production; the assertion that
	// matters is the absence of a backslash, not the presence of the versions.
	it("tilde specifiers and underscored names survive the table writer unescaped", async () => {
		const deps = (semver: string, underscored: string) => ({
			"@effected/semver": semver,
			some_pkg: underscored,
		});
		setupRepo(root, {
			workspaceYaml: WS_LEAF,
			leaf: {
				name: "@scope/leaf",
				version: "0.1.0",
				private: false,
				dependencies: deps("~0.2.0", "1.0.0"),
			},
		});
		writeJson(join(root, "packages", "leaf", "package.json"), {
			name: "@scope/leaf",
			version: "0.1.0",
			private: false,
			dependencies: deps("~0.2.1", "2.0.0"),
		});

		const result = await run(root);
		expect(result).toHaveLength(1);
		const [{ content }] = emitted(root);

		// The corruption, stated directly: no cell may carry a backslash escape.
		expect(content).not.toContain("\\");
		// ...and the values round-trip verbatim.
		expect(content).toContain("~0.2.0");
		expect(content).toContain("~0.2.1");
		expect(content).toContain("some_pkg");
	});

	it("non-versionable package (private, no publish target) is gated out", async () => {
		setupRepo(root, {
			workspaceYaml: WS_LEAF,
			leaf: { name: "@scope/leaf", version: "0.1.0", private: true, dependencies: { effect: "3.0.0" } },
		});
		writeJson(join(root, "packages", "leaf", "package.json"), {
			name: "@scope/leaf",
			version: "0.1.0",
			private: true,
			dependencies: { effect: "3.2.0" },
		});

		const result = await run(root);
		expect(result).toHaveLength(0);
		expect(emitted(root)).toHaveLength(0);
	});
});
