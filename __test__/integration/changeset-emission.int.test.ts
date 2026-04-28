/**
 * Integration tests for changeset emission against committed fixtures.
 *
 * Each scenario runs the full pipeline (capture lockfile state before
 * and after, derive LockfileChange records via Lockfile.compare, hand
 * them to Changesets.create) and asserts on the emitted changeset files.
 *
 * The peer-sync-rewrite scenario uses a synthetic peerUpdates input
 * because pnpm lockfiles don't record workspace peerDependencies in
 * importer sections.
 */

import { copyFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { WorkspaceDiscoveryLive, WorkspaceRootLive } from "workspaces-effect";
import type { DependencyUpdateResult } from "../../src/schemas/domain.js";
import { ChangesetConfigLive } from "../../src/services/changeset-config.js";
import { Changesets, ChangesetsLive } from "../../src/services/changesets.js";
import { captureLockfileState, compareLockfiles } from "../../src/services/lockfile.js";
import { PublishabilityDetectorAdaptiveLive } from "../../src/services/publishability.js";
import { loadFixture } from "./utils/load-fixture.js";

const platform = NodeContext.layer;
const discoveryLayer = WorkspaceDiscoveryLive.pipe(
	Layer.provide(Layer.merge(WorkspaceRootLive.pipe(Layer.provide(platform)), platform)),
);

// Combined layer for Changesets and its dependencies
const fullLayer = ChangesetsLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			discoveryLayer,
			PublishabilityDetectorAdaptiveLive.pipe(Layer.provide(ChangesetConfigLive)),
			ChangesetConfigLive,
		),
	),
);

interface ScenarioResult {
	readonly emitted: ReadonlyArray<{ readonly name: string; readonly content: string }>;
}

const runScenario = async (
	fixtureName: string,
	options: { readonly peerUpdates?: ReadonlyArray<DependencyUpdateResult> } = {},
): Promise<ScenarioResult> => {
	const fixture = loadFixture(fixtureName);
	const peerUpdates = options.peerUpdates ?? [];

	copyFileSync(join(fixture.path, "pnpm-lock.before.yaml"), join(fixture.path, "pnpm-lock.yaml"));
	const before = await Effect.runPromise(captureLockfileState(fixture.path));

	copyFileSync(join(fixture.path, "pnpm-lock.after.yaml"), join(fixture.path, "pnpm-lock.yaml"));
	const after = await Effect.runPromise(captureLockfileState(fixture.path));

	const changes = await Effect.runPromise(
		compareLockfiles(before, after, fixture.path).pipe(Effect.provide(discoveryLayer)),
	);

	await Effect.runPromise(
		Effect.flatMap(Changesets, (c) => c.create(fixture.path, changes, [], peerUpdates)).pipe(Effect.provide(fullLayer)),
	);

	const csDir = join(fixture.path, ".changeset");
	const emitted = readdirSync(csDir)
		.filter((f) => f.endsWith(".md") && f !== "config.json")
		.map((f) => ({ name: f, content: readFileSync(join(csDir, f), "utf-8") }));

	return { emitted };
};

describe("changeset emission integration", () => {
	// ─── Group A: silk fixtures with lockfile diffs ──────────────────────────

	it("silk-prod-dep-bump: leaf prod-dep change writes one changeset for the leaf", async () => {
		const { emitted } = await runScenario("silk-prod-dep-bump");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"@scope/silk-leaf": patch');
		expect(emitted[0].content).toContain("| lodash |");
	});

	it("silk-devdep-only: devDep-only leaf change writes nothing", async () => {
		const { emitted } = await runScenario("silk-devdep-only");
		expect(emitted).toHaveLength(0);
	});

	it("silk-private-versionable: root prod-dep change writes a changeset for the private versionable root", async () => {
		const { emitted } = await runScenario("silk-private-versionable");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"silk-private-versionable-root": patch');
	});

	it("silk-private-not-versionable: root prod-dep change writes nothing for the non-versionable root", async () => {
		const { emitted } = await runScenario("silk-private-not-versionable");
		expect(emitted).toHaveLength(0);
	});

	// ─── Group B: silk fixtures testing publishConfig.targets ────────────────

	it("silk-targets-public: private leaf with public-access target gets a changeset", async () => {
		const { emitted } = await runScenario("silk-targets-public");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"@scope/silk-targets-public-leaf": patch');
	});

	it("silk-targets-none: private leaf with no resolved access gets no changeset", async () => {
		const { emitted } = await runScenario("silk-targets-none");
		expect(emitted).toHaveLength(0);
	});

	// ─── Group C: vanilla fixtures ───────────────────────────────────────────

	it("vanilla-public: public leaf in vanilla mode gets a changeset", async () => {
		const { emitted } = await runScenario("vanilla-public");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"@scope/vanilla-public-leaf": patch');
	});

	it("vanilla-private: private leaf in vanilla mode (no publishConfig.access) gets no changeset", async () => {
		const { emitted } = await runScenario("vanilla-private");
		expect(emitted).toHaveLength(0);
	});

	// ─── Group D: catalog fixtures ───────────────────────────────────────────

	it("catalog-affects-prod-dep: catalog change consumed in dependencies triggers a changeset", async () => {
		const { emitted } = await runScenario("catalog-affects-prod-dep");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"@scope/catalog-prod-leaf": patch');
	});

	it("catalog-affects-dev-only: catalog change consumed only in devDependencies writes nothing", async () => {
		const { emitted } = await runScenario("catalog-affects-dev-only");
		expect(emitted).toHaveLength(0);
	});

	// ─── Group E: peer-sync ──────────────────────────────────────────────────

	it("peer-sync-rewrite: synthetic peer update triggers a changeset", async () => {
		const { emitted } = await runScenario("peer-sync-rewrite", {
			peerUpdates: [
				{
					dependency: "lodash",
					from: "^4.17.20",
					to: "^4.17.21",
					type: "peerDependency",
					package: "@scope/peer-sync-leaf",
				},
			],
		});
		expect(emitted).toHaveLength(1);
		expect(emitted[0].content).toContain('"@scope/peer-sync-leaf": patch');
		expect(emitted[0].content).toContain("| lodash |");
	});

	// ─── Group F: negative scenarios ─────────────────────────────────────────

	it("pnpm-upgrade-only: no real lockfile change writes nothing", async () => {
		const { emitted } = await runScenario("pnpm-upgrade-only");
		expect(emitted).toHaveLength(0);
	});

	it("config-dep-no-catalog-effect: no real lockfile change writes nothing", async () => {
		const { emitted } = await runScenario("config-dep-no-catalog-effect");
		expect(emitted).toHaveLength(0);
	});
});
