/**
 * The action's output contract: the declared names, the "nothing happened"
 * baseline, and the one emitter.
 *
 * `action.yml` is the single source of the output names; this module mirrors it
 * as data so the mirror can be checked rather than assumed
 * (`__test__/unit/schema/outputs.test.ts` reads the manifest and compares).
 *
 * @module schema/outputs
 */

import type { ActionOutputError } from "@effected/github-actions";
import { ActionOutputs } from "@effected/github-actions";
import { Effect } from "effect";

/**
 * Every output declared in `action.yml`, in manifest order.
 *
 * Kept as a tuple rather than a loose array so {@link OutputName} is the exact
 * union of declared names and a typo cannot typecheck.
 */
export const OUTPUT_NAMES = ["pr-number", "pr-url", "updates-count", "has-changes"] as const;

/** A name this action is allowed to publish. */
export type OutputName = (typeof OUTPUT_NAMES)[number];

/** Every declared output, as strings — the form the runner actually stores. */
export type OutputsModel = Readonly<Record<OutputName, string>>;

/**
 * Every output at its "nothing happened" value.
 *
 * @remarks
 * `has-changes` is `"false"` and `updates-count` is `"0"` because that is what a
 * run which did nothing honestly produced. The two PR outputs are empty strings
 * because there is no such thing as a "default" pull request — absence is the
 * honest answer, and an empty string is how the runner represents it.
 */
export const initialOutputs: OutputsModel = {
	"pr-number": "",
	"pr-url": "",
	"updates-count": "0",
	"has-changes": "false",
};

/**
 * Publish a full set of outputs.
 *
 * Writes every declared name, so a caller cannot publish a partial set by
 * accident — the failure this exists to prevent is an output the manifest
 * declares and the run never sets, which a consuming workflow reads as the empty
 * string rather than as the value the action would have chosen.
 */
export const emitOutputs = (outputs: OutputsModel): Effect.Effect<void, ActionOutputError, ActionOutputs> =>
	Effect.gen(function* () {
		const sink = yield* ActionOutputs;
		for (const name of OUTPUT_NAMES) {
			yield* sink.set(name, outputs[name]);
		}
	});
