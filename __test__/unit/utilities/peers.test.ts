/**
 * Tests for the peer-gate decision.
 *
 * The decision is pure and lives outside the step so every arm is testable
 * without a lockfile, a layer or a subprocess. The arms that matter are the
 * ones where a report has ZERO required rows and is still not a pass —
 * `@effected/workspaces` states that both `unverified` reasons mean fail
 * closed, and a gate reading `required.length === 0` as "clean" is exactly the
 * silent pass `supported` / `unresolvedImporters` / `unverified` exist to
 * prevent.
 *
 * @module utilities/peers.test
 */

import { describe, expect, it } from "vitest";
import { decidePeerGate } from "../../../src/utils/peers.js";

const clean = { supported: true, unresolvedImporters: [], unverified: [], requiredCount: 0 } as const;

// Every existing case below runs with auto-merge ENABLED; the disabled arm is
// its own describe, because "withheld" is only meaningful when there was
// something to withhold.
const ON = true;

describe("decidePeerGate", () => {
	it("never withholds when the check is disabled", () => {
		expect(decidePeerGate("false", { ...clean, requiredCount: 3 }, ON).withhold).toBe(false);
	});

	// warn is report-only by definition: it must not gate even on a report that
	// would block under no-auto-merge, or the two modes are the same mode.
	it("never withholds in warn mode, even with required peers", () => {
		const d = decidePeerGate("warn", { ...clean, requiredCount: 3 }, ON);
		expect(d.withhold).toBe(false);
		expect(d.reason).toBe("report-only");
	});

	it("does not withhold on a proven-clean report", () => {
		const d = decidePeerGate("no-auto-merge", clean, ON);
		expect(d.withhold).toBe(false);
		expect(d.reason).toBe("proven-clean");
	});

	it("withholds when a required peer is unsatisfied", () => {
		const d = decidePeerGate("no-auto-merge", { ...clean, requiredCount: 2 }, ON);
		expect(d.withhold).toBe(true);
		expect(d.reason).toBe("required-unsatisfied");
	});

	// The four "zero rows but not a pass" arms. Each is a silent pass if missed.
	it.each([
		["peerRulesNotApplied", { ...clean, unverified: ["peerRulesNotApplied"] }, "unverified"],
		["unresolvedEdge", { ...clean, unverified: ["unresolvedEdge"] }, "unverified"],
		["an unresolved importer", { ...clean, unresolvedImporters: ["packages/app"] }, "unresolved-importers"],
		["an unsupported format", { ...clean, supported: false }, "unsupported"],
	])("withholds on %s despite zero required rows", (_label, summary, reason) => {
		const d = decidePeerGate("no-auto-merge", summary, ON);
		expect(d.withhold).toBe(true);
		expect(d.reason).toBe(reason);
	});

	// Ordering matters for the log line: an unsupported format is why there are
	// no rows, so reporting "unverified" there would send the reader to the
	// wrong explanation.
	it("reports the most specific reason when several apply", () => {
		const d = decidePeerGate(
			"no-auto-merge",
			{
				supported: false,
				unresolvedImporters: ["a"],
				unverified: ["peerRulesNotApplied"],
				requiredCount: 5,
			},
			ON,
		);
		expect(d.reason).toBe("unsupported");
	});
});

describe("decidePeerGate — auto-merge disabled", () => {
	// The bug this pins: `withheld` fed the PR body, which then told a reviewer
	// "auto-merge was withheld, this pull request was not merged automatically"
	// on a repo that never had auto-merge enabled. Nothing was withheld, and the
	// note sent the reader looking for a peer problem behind a decision that was
	// never taken.
	it("withholds nothing when auto-merge was never enabled", () => {
		const d = decidePeerGate("no-auto-merge", { ...clean, requiredCount: 4 }, false);
		expect(d.withhold).toBe(false);
		expect(d.reason).toBe("auto-merge-disabled");
	});

	it("still withholds nothing on an unverified report when auto-merge is off", () => {
		const d = decidePeerGate("no-auto-merge", { ...clean, unverified: ["unresolvedEdge"] }, false);
		expect(d.withhold).toBe(false);
	});
});
