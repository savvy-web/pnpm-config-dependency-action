/**
 * Tests for the peer-check step.
 *
 * The fixture is REAL pnpm 11.22.0 output (react-dom@18.3.1 against
 * react@17.0.2), not a hand-written lockfile: the whole feature turns on
 * reading a manager's own format correctly, and a fixture we authored would
 * only prove we can read what we invented.
 *
 * @module steps/peer-check.test
 */

import { readFileSync } from "node:fs";
import { Lockfile } from "@effected/lockfiles";
import { NoPeerDependencyRules, WorkspaceCatalogs } from "@effected/workspaces";
import type { Layer } from "effect";
import { Effect, References } from "effect";
import { describe, expect, it } from "vitest";
import { peerCheckStep } from "../../../src/steps/peer-check.js";

const lockfile = Effect.runSync(
	Lockfile.parse(readFileSync(new URL("./__fixtures__/pnpm-lock.unmet-peer.yaml", import.meta.url), "utf8"), {
		format: "pnpm",
	}),
);

/** A catalogs double that answers with rules; unstubbed members die naming themselves. */
const withRules = WorkspaceCatalogs.layerTest({
	peerDependencyRules: () => Effect.succeed(NoPeerDependencyRules),
});

/** The degradation path: the rules lookup itself fails. */
const rulesFail = WorkspaceCatalogs.layerTest({
	peerDependencyRules: () => Effect.fail({ _tag: "CatalogAssemblyError", source: "hooks" } as never),
});

const run = (
	mode: Parameters<typeof peerCheckStep>[0],
	lf: typeof lockfile | null,
	layer: Layer.Layer<WorkspaceCatalogs>,
) =>
	Effect.runPromise(
		peerCheckStep(mode, lf, "/ws").pipe(
			Effect.provide(layer),
			Effect.provideService(References.MinimumLogLevel, "None"),
		),
	);

describe("peerCheckStep", () => {
	// The double has NO peerDependencyRules stub here, so it dies if touched.
	// That is the assertion: disabled must not evaluate config-dependency hooks,
	// which spawn a subprocess in a consumer's repository.
	it("does no work at all when disabled", async () => {
		const result = await run("false", lockfile, WorkspaceCatalogs.layerTest());
		expect(result.issues).toEqual([]);
		expect(result.decision.reason).toBe("disabled");
		expect(result.decision.withhold).toBe(false);
	});

	it("reports the unsatisfied peer in warn mode without gating", async () => {
		const result = await run("warn", lockfile, withRules);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues[0]?.dependency).toBe("react");
		expect(result.issues[0]?.found).toBe("17.0.2");
		expect(result.decision.withhold).toBe(false);
	});

	it("withholds auto-merge on a required unsatisfied peer", async () => {
		const result = await run("no-auto-merge", lockfile, withRules);
		expect(result.decision.withhold).toBe(true);
		expect(result.decision.reason).toBe("required-unsatisfied");
	});

	// Degradation, not propagation: the step's error channel is `never`. A
	// rules lookup that fails must NOT fail the run, and must NOT silently
	// become a pass -- it fails closed via `unverified`.
	it("fails closed rather than failing the run when the rules lookup errors", async () => {
		const result = await run("no-auto-merge", lockfile, rulesFail);
		expect(result.decision.withhold).toBe(true);
		expect(result.decision.reason).toBe("unverified");
	});

	// No lockfile means nothing was examined. Reporting that as clean would be
	// the silent pass in its purest form.
	it("fails closed when there is no lockfile to check", async () => {
		const result = await run("no-auto-merge", null, withRules);
		expect(result.decision.withhold).toBe(true);
		expect(result.issues).toEqual([]);
	});
});
