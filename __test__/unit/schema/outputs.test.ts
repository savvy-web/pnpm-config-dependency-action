import { readFileSync } from "node:fs";
import { ActionOutputs } from "@effected/github-actions";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RunResultDocument } from "../../../src/schema/domain.js";
import {
	OUTPUT_NAMES,
	emitOutputs,
	emptyRunResult,
	encodeRunResult,
	initialOutputs,
} from "../../../src/schema/outputs.js";

/**
 * The output names `action.yml` declares, read straight from the manifest.
 *
 * Parsed with a narrow regex rather than a YAML dependency: the `outputs:` block
 * is a flat map of `  <name>:` keys, and anchoring on the block keeps a nested
 * `description:` from being mistaken for an output.
 */
const manifestOutputNames = (): ReadonlyArray<string> => {
	const yaml = readFileSync(new URL("../../../action.yml", import.meta.url), "utf-8");
	const block = /\noutputs:\n([\s\S]*?)(?=\nruns:)/.exec(yaml);
	if (block === null) throw new Error("action.yml has no outputs: block");
	return [...block[1].matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
};

describe("OUTPUT_NAMES", () => {
	it("mirrors action.yml exactly", () => {
		// action.yml is the single source of output names; this tuple is a mirror,
		// and a mirror nobody checks is just a second source.
		expect([...OUTPUT_NAMES].sort()).toEqual([...manifestOutputNames()].sort());
	});

	it("covers every declared name in initialOutputs", () => {
		expect(Object.keys(initialOutputs).sort()).toEqual([...OUTPUT_NAMES].sort());
	});
});

describe("initialOutputs", () => {
	it("is the honest nothing-happened state", () => {
		// Not arbitrary: a run that did nothing produced no changes and no updates,
		// and there is no default pull request — absence is an empty string.
		expect(initialOutputs).toEqual({
			"pr-number": "",
			"pr-url": "",
			"updates-count": "0",
			"has-changes": "false",
			result: encodeRunResult(emptyRunResult),
		});
	});

	it("makes `result` parseable unconditionally, not an empty string", () => {
		// The whole point of a structured output: a consumer runs
		// `fromJSON(steps.x.outputs.result)` without guarding. A baseline of "" would
		// force every reader to branch, which is the same defect as an unset scalar
		// output wearing a different hat.
		expect(initialOutputs.result).not.toBe("");
		expect(() => JSON.parse(initialOutputs.result)).not.toThrow();
	});

	it("publishes a baseline `result` that decodes against the schema", () => {
		// A baseline that serializes but does not decode would be a document the
		// action promises and its own schema rejects.
		const decoded = Schema.decodeUnknownSync(RunResultDocument)(JSON.parse(initialOutputs.result));
		expect(decoded.hasChanges).toBe(false);
		expect(decoded.schemaVersion).toBe(2);
		expect(decoded.pullRequest).toBeNull();
		// Null, not a placeholder: a run that ended before detection has no package
		// manager, and a value that decodes and is false is worse than an absent one.
		expect(decoded.packageManager).toBeNull();
		for (const key of ["updates", "catalogDeltas", "lockfileChanges", "changesets"] as const) {
			// Arrays are empty rather than omitted, so a consumer can index without guarding.
			expect(decoded[key]).toEqual([]);
		}
	});
});

describe("emitOutputs", () => {
	it("publishes every declared output, not a subset", async () => {
		// The regression this guards: `has-changes` and `updates-count` were set on
		// some exit paths while `pr-number`/`pr-url` were set on none of them, so a
		// consuming workflow read an empty string where the manifest promised a
		// value. Asserting on the recorded key SET (not just a couple of values) is
		// what makes a partial emitter fail here.
		const written = new Map<string, string>();
		const recording = ActionOutputs.layerTest({
			set: (name: string, value: string) =>
				Effect.suspend(() => {
					written.set(name, value);
					return Effect.void;
				}),
		});

		await Effect.runPromise(emitOutputs(initialOutputs).pipe(Effect.provide(recording)));

		expect([...written.keys()].sort()).toEqual([...OUTPUT_NAMES].sort());
		expect(Object.fromEntries(written)).toEqual(initialOutputs);
	});
});
