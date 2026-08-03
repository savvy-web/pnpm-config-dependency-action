/**
 * Unit tests for the Changesets service — a thin adapter over
 * `@savvy-web/silk-effects` `Changesets.DepsRegen`.
 *
 * The gating cascade (versionable-minus-ignored), catalog-aware diffing, and
 * pure-dependency consolidation all live upstream in DepsRegen and are tested
 * in `@savvy-web/silk-effects`; here we only assert the adapter's plumbing:
 * the `.changeset/` guard, the `plan({ cwd, base }) → execute` call, the
 * `written → ChangesetFile` mapping, and error mapping. End-to-end emission is
 * covered by `__test__/integration/changeset-emission.int.test.ts`.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { Changesets, ChangesetsLive } from "../../../src/services/changesets.js";
import { silentLogger } from "../../utils/fixtures.js";

type RegenPlan = SilkChangesets.RegenPlan;
type RegenResult = SilkChangesets.RegenResult;

/** A minimal single-row dependency diff for a package. */
const diffFor = (pkg: string) => ({
	package: pkg,
	relativePath: ".",
	rows: [{ dependency: "effect", type: "dependency" as const, action: "updated" as const, from: "3.0.0", to: "3.2.0" }],
});

/**
 * Mock DepsRegen. `plan` records the options it received and returns the given
 * plan (or a thrown error); `execute` returns the given result. Neither touches
 * the filesystem — the adapter's own `hasChangesets` guard is the only real I/O.
 */
const mockDepsRegen = (opts: {
	plan?: RegenPlan;
	planError?: unknown;
	result?: RegenResult;
	capture?: { options?: unknown };
}) =>
	Layer.succeed(SilkChangesets.DepsRegen, {
		plan: (options) => {
			if (opts.capture) opts.capture.options = options;
			if (opts.planError !== undefined) return Effect.fail(opts.planError as never);
			return Effect.succeed((opts.plan ?? { toDelete: [], toWrite: [], skippedMixed: [] }) as RegenPlan);
		},
		execute: () => Effect.succeed((opts.result ?? { deleted: [], written: [], skippedMixed: [] }) as RegenResult),
	} as typeof SilkChangesets.DepsRegen.Service);

const run = (root: string, base: string, layer: Layer.Layer<SilkChangesets.DepsRegen>) =>
	Effect.runPromise(
		Effect.flatMap(Changesets, (c) => c.create(root, base)).pipe(
			Effect.provide(ChangesetsLive.pipe(Layer.provide(layer))),
			Effect.provide(silentLogger),
		),
	);

describe("Changesets — DepsRegen adapter", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cs-"));
	});

	it("returns [] and skips DepsRegen when .changeset/ does not exist", async () => {
		const capture: { options?: unknown } = {};
		const result = await run(tmpDir, "main", mockDepsRegen({ capture }));
		expect(result).toEqual([]);
		// plan() must not have been invoked (no .changeset dir).
		expect(capture.options).toBeUndefined();
	});

	it("passes { cwd, base } through to plan()", async () => {
		mkdirSync(join(tmpDir, ".changeset"), { recursive: true });
		const capture: { options?: unknown } = {};
		await run(tmpDir, "release-base", mockDepsRegen({ capture }));
		expect(capture.options).toEqual({ cwd: tmpDir, base: "release-base" });
	});

	it("maps written files to ChangesetFile records with the rendered table", async () => {
		mkdirSync(join(tmpDir, ".changeset"), { recursive: true });
		const file = join(tmpDir, ".changeset", "brave-owls-soar.md");
		const plan: RegenPlan = {
			toDelete: [],
			toWrite: [{ file, package: "@x/a", diff: diffFor("@x/a") }],
			skippedMixed: [],
		} as unknown as RegenPlan;
		const result = await run(
			tmpDir,
			"main",
			mockDepsRegen({ plan, result: { deleted: [], written: [file], skippedMixed: [] } as RegenResult }),
		);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("brave-owls-soar");
		expect(result[0].packages).toEqual(["@x/a"]);
		expect(result[0].type).toBe("patch");
		expect(result[0].summary).toContain("## Dependencies");
		expect(result[0].summary).toContain("effect");
		expect(result[0].summary).toContain("3.2.0");
	});

	it("only maps files that were actually written (not deleted/stale)", async () => {
		mkdirSync(join(tmpDir, ".changeset"), { recursive: true });
		const written = join(tmpDir, ".changeset", "written.md");
		const stale = join(tmpDir, ".changeset", "stale.md");
		const plan: RegenPlan = {
			toDelete: [{ file: stale, package: "@x/a" }],
			toWrite: [{ file: written, package: "@x/a", diff: diffFor("@x/a") }],
			skippedMixed: [],
		} as unknown as RegenPlan;
		const result = await run(
			tmpDir,
			"main",
			mockDepsRegen({ plan, result: { deleted: [stale], written: [written], skippedMixed: [] } as RegenResult }),
		);
		expect(result.map((c) => c.id)).toEqual(["written"]);
	});

	it("collapses a DepsRegen failure into ChangesetError", async () => {
		mkdirSync(join(tmpDir, ".changeset"), { recursive: true });
		await expect(
			run(tmpDir, "main", mockDepsRegen({ planError: new Error("merge-base failed: unknown revision main") })),
		).rejects.toThrow(/changeset regeneration failed/);
	});
});
