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
import type { Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeAppLayer } from "../../../src/layers/app.js";

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

describe("makeAppLayer", () => {
	it("requires nothing beyond ActionServices", () => {
		// The real assertion is the type annotation above — this run-time check
		// only keeps the suite honest that the module was actually evaluated.
		expect(_everyRequirementIsProvidedByActionRun).toBe(true);
		expect(makeAppLayer(true)).toBeDefined();
	});
});
