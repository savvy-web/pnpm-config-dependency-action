/**
 * Requirement-channel guard for `makeAppLayer`.
 *
 * The teeth here are at COMPILE time, not in the runtime assertion below.
 *
 * `Action.run` is typed `<E, R = never>(program: Effect<void, E, ActionServices | R>,
 * options?: ActionRunOptions<R>)`. Because `options` is optional, `R` infers to
 * whatever the program still requires and nothing forces a layer to be passed —
 * so a domain layer that resolves a service `makeAppLayer` never provides
 * typechecks cleanly and fails only on the runner, as a defect.
 *
 * That shipped: `PackageManagerUpgrade.layer` resolves `PackageJsonFile` in its
 * layer body, `makeAppLayer` provided it to `RuntimeUpgrade.layer` only, and
 * v4.6.0 died on every run with
 * `Service not found: @effected/package-json/PackageJsonFile` before the check
 * run was even created. Nothing in the type system or the suite objected.
 *
 * The assertion below closes that: anything left in `makeAppLayer`'s requirement
 * channel that `ActionServices` does not supply is a type error here.
 */

import type { ActionServices } from "@effected/github-actions";
import type { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeAppLayer } from "../../../src/layers/app.js";
import type { innerProgram } from "../../../src/program.js";

type RequirementsOf<L> = L extends Layer.Layer<infer _Out, infer _E, infer In> ? In : never;

/** Everything `makeAppLayer` still needs from its caller. */
type AppLayerRequirements = RequirementsOf<ReturnType<typeof makeAppLayer>>;

/**
 * What is left over after `Action.run`'s runtime satisfies what it can.
 *
 * MUST be `never`. When it is not, the annotation below resolves to the leftover
 * service type and `true` stops being assignable to it — naming the missing
 * service in the compiler error.
 */
type UnsatisfiedRequirements = Exclude<AppLayerRequirements, ActionServices>;

const _everyRequirementIsProvidedByActionRun: [UnsatisfiedRequirements] extends [never]
	? true
	: UnsatisfiedRequirements = true;

/**
 * The OTHER half, and the one the layer-side assertion structurally cannot see.
 *
 * `AppLayerRequirements` above is the layer's INPUT channel — what `makeAppLayer`
 * still needs. It says nothing about what the layer OUTPUTS, so a service the
 * program resolves and the layer never exposes is invisible to it.
 *
 * That is not hypothetical and it is not the same bug as the one above.
 * `steps/peer-check.ts` resolves `WorkspaceCatalogs` in its own body — a METHOD,
 * not a layer body — so the requirement lands here on `innerProgram` rather than
 * on the layer's input channel. `makeAppLayer` built `workspaceCatalogs` and
 * piped it into `ReleaseAge` alone without merging it into the returned layer.
 * Clean `tsc`, 634 green tests, and every consumer run died with
 * `Service not found: @effected/workspaces/WorkspaceCatalogs`.
 *
 * The unit suite could not catch it either, and that is the sharper lesson: the
 * composition harness supplies its own `WorkspaceCatalogs.layerTest`, so the
 * DOUBLE was more capable than production. A fake that is more complete than the
 * real thing hides exactly the wiring bug it appears to exercise.
 */
type RequirementsOfEffect<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

/** What `innerProgram` still needs AFTER it provides `appLayer` internally. */
type InnerProgramRequirements = RequirementsOfEffect<ReturnType<typeof innerProgram>>;

/** MUST be `never`, for the same reason and with the same teeth as above. */
type UnsatisfiedProgramRequirements = Exclude<InnerProgramRequirements, ActionServices>;

const _programNeedsNothingBeyondActionRun: [UnsatisfiedProgramRequirements] extends [never]
	? true
	: UnsatisfiedProgramRequirements = true;

describe("makeAppLayer", () => {
	it("requires nothing beyond ActionServices", () => {
		// The real assertion is the type annotation above — this run-time check
		// only keeps the suite honest that the module was actually evaluated.
		expect(_everyRequirementIsProvidedByActionRun).toBe(true);
		expect(makeAppLayer(true)).toBeDefined();
	});

	it("provides everything innerProgram resolves, not just what its own layers need", () => {
		// Again the type annotation is the assertion. This catches the class the
		// check above cannot: a service resolved in a STEP body, which never
		// enters the layer's input channel at all.
		expect(_programNeedsNothingBeyondActionRun).toBe(true);
	});
});
