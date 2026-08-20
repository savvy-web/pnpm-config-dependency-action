import { describe, expect, it } from "vitest";
import {
	formatCatalogCounts,
	formatCatalogCountsCompact,
	groupCatalogDeltas,
	resultLines,
	runContextLines,
} from "../../src/format.js";
import type { CatalogDelta, DependencyUpdateResult } from "../../src/schema/domain.js";

/**
 * These suites assert the **shape** of the decision record — which lines appear,
 * in what order, and which facts are conditional.
 *
 * They deliberately do NOT re-assert the exact wording of every line.
 * `program.inner.test.ts` owns the log contract by asserting the captured stream
 * end to end, and it stays authoritative: duplicating its exact strings here
 * would mean a wording change has to be edited in two places, and the second one
 * would eventually be the one nobody updated.
 */

const detected = { pm: "pnpm", version: "11.20.0", root: "/ws", evidence: "pnpm-workspace.yaml" } as const;

const baseContext = {
	detected,
	evidence: "pnpm-workspace.yaml" as const,
	packageCount: 3,
	lockfileName: "pnpm-lock.yaml",
	branch: "pnpm/config-deps",
	sourceBranch: "main",
	targetBranch: "main",
	dryRun: false,
	changesets: true,
	runtimeData: "offline",
};

describe("runContextLines", () => {
	it("emits the header plus one line per fact, in order", () => {
		const lines = runContextLines(baseContext);

		expect(lines[0]).toBe("Run context");
		expect(lines).toHaveLength(6);
		// The block is emitted as one unit, so the labels must stay in this order.
		expect(lines.slice(1).map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
			"package manager",
			"workspace root",
			"lockfile",
			"branches",
			"mode",
		]);
	});

	it("reports the detector's own evidence marker", () => {
		// `evidence` is non-nullable now: it is forwarded from the detector, which
		// always carries one. The previous "absence reads as absence" case is gone
		// because it is no longer representable — while this was locally
		// re-derived, the helper could fail to establish an answer and returned
		// null. Asserting the null branch now would pin a state the type forbids.
		expect(runContextLines(baseContext)[1]).toContain("(pnpm-workspace.yaml)");
		expect(runContextLines({ ...baseContext, evidence: "bun.lock" })[1]).toContain("(bun.lock)");
	});

	it("includes the package count only when discovery succeeded", () => {
		expect(runContextLines(baseContext)[2]).toContain("(3 packages)");
		expect(runContextLines({ ...baseContext, packageCount: null })[2]).not.toContain("package");
	});

	it("singularizes a one-package workspace", () => {
		expect(runContextLines({ ...baseContext, packageCount: 1 })[2]).toContain("(1 package)");
	});

	it("reports dry run distinctly from live", () => {
		expect(runContextLines(baseContext)[5]).toContain("live");
		expect(runContextLines({ ...baseContext, dryRun: true })[5]).toContain("dry run");
	});
});

const update = (over: Partial<DependencyUpdateResult> = {}): DependencyUpdateResult => ({
	dependency: "effect",
	from: "^3.0.0",
	to: "^4.0.0",
	type: "dependency",
	package: null,
	...over,
});

const baseResult = {
	updates: [] as ReadonlyArray<DependencyUpdateResult>,
	deltas: [] as ReadonlyArray<CatalogDelta>,
	packageManagerSkip: null,
	peerConfigured: true,
	isPnpm: true,
	customCommandsConfigured: true,
	changesetsSkip: null,
	peers: { issues: 0, required: 0, withheld: false, reason: "proven-clean" as const },
};

describe("resultLines", () => {
	it("emits only the header when everything ran and nothing changed", () => {
		expect(resultLines(baseResult)).toEqual(["Result"]);
	});

	it("reports updates when there are any", () => {
		const lines = resultLines({ ...baseResult, updates: [update()] });
		expect(lines.some((l) => l.includes("updated"))).toBe(true);
		expect(lines.some((l) => l.includes("effect"))).toBe(true);
	});

	it("renders an added dependency as `added` rather than a null", () => {
		const lines = resultLines({ ...baseResult, updates: [update({ from: null })] });
		expect(lines.join("\n")).toContain("added -> ^4.0.0");
		expect(lines.join("\n")).not.toContain("null");
	});

	it("collects every skip reason into one line", () => {
		// The half that matters: a step that did not run must always say so.
		const lines = resultLines({
			...baseResult,
			packageManagerSkip: "disabled (upgrade-package-manager: false)",
			peerConfigured: false,
			isPnpm: false,
			customCommandsConfigured: false,
			changesetsSkip: "no .changeset/ directory",
		});
		const skipped = lines.find((l) => l.includes("skipped"));
		expect(skipped).toBeDefined();
		for (const fragment of [
			"package-manager upgrade",
			"peer sync",
			"workspace formatting",
			"custom commands",
			"changesets",
		]) {
			expect(skipped).toContain(fragment);
		}
	});

	it("omits the skipped line entirely when every step ran", () => {
		expect(resultLines(baseResult).some((l) => l.includes("skipped"))).toBe(false);
	});
});

describe("catalog tallies", () => {
	const deltas: ReadonlyArray<CatalogDelta> = [
		{ catalog: "default", dependency: "a", from: "1", to: "2", action: "updated" },
		{ catalog: "default", dependency: "b", from: null, to: "1", action: "added" },
		{ catalog: "tools", dependency: "c", from: "1", to: null, action: "removed" },
		{ catalog: "tools", dependency: "d", from: "1", to: "1", action: "kept" },
	];

	it("groups by catalog and tallies each action", () => {
		const grouped = groupCatalogDeltas(deltas);
		expect(grouped.get("default")).toEqual({ added: 1, updated: 1, removed: 0, kept: 0 });
		expect(grouped.get("tools")).toEqual({ added: 0, updated: 0, removed: 1, kept: 1 });
	});

	it("renders the verbose tally with every non-zero action", () => {
		expect(formatCatalogCounts({ added: 1, updated: 2, removed: 3, kept: 4 })).toBe(
			"2 updated, 1 added, 3 removed, 4 kept",
		);
	});

	it("omits `kept` from the compact tally", () => {
		// `kept` means a user override survived — not a change, so the compact form
		// used in the Result block deliberately drops it.
		expect(formatCatalogCountsCompact({ added: 1, updated: 2, removed: 3, kept: 99 })).toBe("+1 ~2 -3");
	});

	it("says `no changes` rather than an empty string in both forms", () => {
		const zero = { added: 0, updated: 0, removed: 0, kept: 0 };
		expect(formatCatalogCounts(zero)).toBe("no changes");
		expect(formatCatalogCountsCompact(zero)).toBe("no changes");
	});
});

describe("resultLines — peer check", () => {
	// Disabled must appear in the SKIPPED summary, not vanish. A step that did
	// not run always says so; silence reads as "ran and found nothing".
	it("reports a disabled peer check as a skip with its reason", () => {
		const lines = resultLines({ ...baseResult, peers: null });
		expect(lines.join("\n")).toContain("peer check");
	});

	// A proven-clean check adds NOTHING here. The step already logged its own
	// info line, and the Result block is a summary of what is notable -- a
	// second "everything is fine" line is noise that trains readers to skim.
	it("says nothing about a proven-clean check", () => {
		expect(resultLines(baseResult)).toEqual(["Result"]);
	});

	// The load-bearing one: a withheld gate must say BOTH that it withheld and
	// why, because "auto-merge did not happen" is otherwise indistinguishable
	// from "auto-merge was never configured".
	it("names the withholding and its reason", () => {
		const lines = resultLines({
			...baseResult,
			peers: { issues: 3, required: 2, withheld: true, reason: "required-unsatisfied" },
		});
		const text = lines.join("\n");
		expect(text).toContain("2 required");
		expect(text).toContain("auto-merge withheld");
		expect(text).toContain("required-unsatisfied");
	});

	// Zero rows and still withheld -- the arm a reader will not expect, so the
	// line has to explain itself rather than showing "0 issues" beside a block.
	it("explains a withholding that has zero rows", () => {
		const lines = resultLines({
			...baseResult,
			peers: { issues: 0, required: 0, withheld: true, reason: "unverified" },
		});
		expect(lines.join("\n")).toContain("unverified");
		expect(lines.join("\n")).toContain("auto-merge withheld");
	});
});
