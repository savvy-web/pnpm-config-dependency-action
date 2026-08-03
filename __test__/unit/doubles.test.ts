/**
 * Self-tests for the shared doubles in `__test__/utils/`.
 *
 * They live in a discovered suite rather than beside the helpers because
 * `AgentPlugin.discover()` EXCLUDES `__test__/utils/**` — that directory is
 * reserved for helper modules, not suites. A `describe` left inside a helper is
 * silently never collected, which shrinks the suite while every local count
 * still looks plausible. Keeping these here makes the doubles' own behavior a
 * gate instead of an assumption.
 *
 * @module unit/doubles.test
 */

import { ActionState } from "@effected/github-actions";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { actionStateTestLayer, emptyActionState } from "../utils/action-doubles.js";
import { configUpdate, regularUpdate, silentLogger } from "../utils/fixtures.js";

describe("fixtures", () => {
	it("exports valid fixture types", () => {
		expect(configUpdate.type).toBe("config");
		expect(regularUpdate.type).toBe("devDependency");
	});
});

describe("action doubles", () => {
	it("round-trips a value through ActionState's schema", async () => {
		const recording = emptyActionState();
		const Payload = Schema.Struct({ startedAt: Schema.Number });

		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* ActionState;
				yield* state.save("k", { startedAt: 7 }, Payload);
				return yield* state.get("k", Payload);
			}).pipe(Effect.provide(actionStateTestLayer(recording))),
		);

		expect(read.startedAt).toBe(7);
		expect(recording.entries.has("k")).toBe(true);
	});

	it("answers none for an unset optional key", async () => {
		const recording = emptyActionState();
		const Payload = Schema.Struct({ startedAt: Schema.Number });

		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* ActionState;
				return yield* state.getOptional("missing", Payload);
			}).pipe(Effect.provide(actionStateTestLayer(recording))),
		);

		expect(Option.isNone(read)).toBe(true);
	});
});

describe("silentLogger", () => {
	// The escape hatch turns the layer into a no-op, which is exactly what this
	// asserts against — so the assertion only holds in the default mode.
	it.skipIf(process.env.TEST_LOGS)("drops log output that would otherwise reach the console", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await Effect.runPromise(Effect.logInfo("silenced").pipe(Effect.provide(silentLogger)));
			expect(spy, "silentLogger should suppress the write").not.toHaveBeenCalled();

			// The control: without the layer the same effect DOES write, so the
			// assertion above is a real constraint rather than a vacuous pass.
			await Effect.runPromise(Effect.logInfo("not silenced"));
			expect(spy, "the default logger should still write").toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
