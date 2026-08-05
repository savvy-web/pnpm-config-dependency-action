import type { StatusEntry } from "@effected/git";
import { Git } from "@effected/git";
import { Effect, References } from "effect";
import { describe, expect, it } from "vitest";
import { detectChangesStep } from "../../../src/steps/detect-changes.js";

/**
 * The step is three lines, and both of its properties were defects at some
 * point, so both are pinned here rather than left to the composition suite.
 *
 * `program.inner.test.ts` exercises this step end to end, but only reads the
 * count — so it would stay green against a step that ran status in the wrong
 * directory or discarded everything except the path.
 */

const runStep = (entries: ReadonlyArray<StatusEntry>, root = "/ws") => {
	const cwds: Array<string> = [];
	const layer = Git.layerTest({
		status: (cwd: string) =>
			Effect.sync(() => {
				cwds.push(cwd);
				return entries;
			}),
	} as never);

	return Effect.runPromise(
		detectChangesStep(root).pipe(
			Effect.provide(layer),
			Effect.provideService(References.MinimumLogLevel, "None"),
			Effect.map((result) => ({ result, cwds })),
		),
	);
};

const entry = (x: StatusEntry["x"], y: StatusEntry["y"], path: string, origPath?: string): StatusEntry =>
	(origPath === undefined ? { x, y, path } : { x, y, path, origPath }) as StatusEntry;

describe("detectChangesStep", () => {
	it("reads status at the workspace root it is given", async () => {
		// The module was extracted specifically to get this I/O out of
		// `program.ts`, and it shipped running at the process cwd — the same
		// defect already fixed twice in `commitChanges` and `ensureBaseHistory`.
		// It discriminates because the asserted root is not this process's cwd.
		const { cwds } = await runStep([], "/some/workspace/root");

		expect(cwds).toEqual(["/some/workspace/root"]);
	});

	it("surfaces the full typed entry, not just the path", async () => {
		// The point of adopting `@effected/git` was that `StatusEntry` makes a
		// class of defect unrepresentable: a rename read as one unusable path, and
		// a deletion whose two columns disagree read as a modification. Narrowing
		// the result to `{ path }` at this boundary would keep the fix and discard
		// the property, and nothing would fail — which is why this assertion
		// exists rather than being left implied by the type.
		const { result } = await runStep([entry("R", " ", "new.ts", "old.ts")]);

		expect(result.entries).toEqual([{ x: "R", y: " ", path: "new.ts", origPath: "old.ts" }]);
	});

	it("reports hasChanges from the entry count", async () => {
		const empty = await runStep([]);
		expect(empty.result.hasChanges).toBe(false);

		const dirty = await runStep([entry(" ", "M", "package.json")]);
		expect(dirty.result.hasChanges).toBe(true);
	});
});
