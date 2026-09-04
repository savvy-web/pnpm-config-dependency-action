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

const parseFixture = (name: string) =>
	Effect.runSync(
		Lockfile.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"), {
			format: "pnpm",
		}),
	);

const lockfile = parseFixture("pnpm-lock.unmet-peer.yaml");

/**
 * Real pnpm 11.22.0 output: the root importer declares
 * `semver-classic: npm:semver@7.6.3`, producing an npm-alias edge at the
 * importer level AND in a snapshot body (via @isaacs/cliui's string-width-cjs).
 */
const aliasLockfile = parseFixture("pnpm-lock.alias.yaml");

/**
 * Real pnpm 11.22.0 output: packages/react publishes from `dist/pkg`
 * (publishConfig.directory + linkDirectory), so react-dom's satisfied peer is
 * recorded as `react: link:packages/react/dist/pkg` in a snapshot body.
 */
const publishDirLockfile = parseFixture("pnpm-lock.publish-dir-link.yaml");

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
		peerCheckStep(mode, lf, "/ws", true).pipe(
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

	// A gate that withholds must say WHY in terms the reader can act on.
	// "(unverified)" alone sent a real run's reader looking for peer problems
	// that did not exist -- the report had zero rows and withheld anyway.
	it("names the specific unverified reasons, not just the verdict", async () => {
		const result = await run("no-auto-merge", lockfile, rulesFail);
		expect(result.decision.reason).toBe("unverified");
		expect(result.unverifiedReasons).toContain("peerRulesNotApplied");
	});

	// No lockfile means nothing was examined. Reporting that as clean would be
	// the silent pass in its purest form.
	it("fails closed when there is no lockfile to check", async () => {
		const result = await run("no-auto-merge", null, withRules);
		expect(result.decision.withhold).toBe(true);
		expect(result.issues).toEqual([]);
	});

	// Upstream-drift canaries for @effected/lockfiles edge resolution. Both
	// fixtures are shapes that used to land in `unresolvedEdges` and flip the
	// report to `unverified ("unresolvedEdge")`, withholding auto-merge from
	// repos with zero real peer problems (spencerbeggs/type-registry-effect#122
	// was the alias case, live). A kit regression fails here rather than
	// resurfacing as withheld auto-merge in consumer repositories.
	it("does not withhold on an npm-alias dependency (kit drift canary)", async () => {
		const result = await run("no-auto-merge", aliasLockfile, withRules);
		expect(result.unverifiedReasons).not.toContain("unresolvedEdge");
		expect(result.decision.withhold).toBe(false);
		expect(result.decision.reason).toBe("proven-clean");
	});

	it("does not withhold on a publishDirectory link: peer edge (kit drift canary)", async () => {
		const result = await run("no-auto-merge", publishDirLockfile, withRules);
		expect(result.unverifiedReasons).not.toContain("unresolvedEdge");
		expect(result.decision.withhold).toBe(false);
		expect(result.decision.reason).toBe("proven-clean");
	});

	// The run mutates the workspace between the first catalogs assembly and this
	// step: config-dependency plugins are bumped and reinstalled, so the rules
	// that govern the "after" lockfile are the AFTER plugins' rules. A step that
	// reads the memoized pre-install assembly judges the new lockfile under the
	// old rules — a live run (pnpm-module-template#84) withheld auto-merge on a
	// row the freshly-installed plugin suppresses. The double only answers with
	// rules once refresh() has been called, so this fails if the step skips the
	// refresh OR orders it after the read.
	it("refreshes the catalogs assembly before reading the rules", async () => {
		const state = { refreshed: false };
		const staleUntilRefreshed = WorkspaceCatalogs.layerTest({
			refresh: () =>
				Effect.sync(() => {
					state.refreshed = true;
				}),
			peerDependencyRules: () =>
				state.refreshed
					? Effect.succeed(NoPeerDependencyRules)
					: Effect.fail({ _tag: "CatalogAssemblyError", source: "stale-memo" } as never),
		});
		const result = await run("no-auto-merge", aliasLockfile, staleUntilRefreshed);
		expect(state.refreshed).toBe(true);
		expect(result.decision.reason).toBe("proven-clean");
	});
});
