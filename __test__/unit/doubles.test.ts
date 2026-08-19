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

import { ActionState, ActionStateError } from "@effected/github-actions";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { actionStateTestLayer, emptyActionState } from "../utils/action-doubles.js";
import { configUpdate, fakeSha, regularUpdate, silentLogger } from "../utils/fixtures.js";

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

	it("FAILS typed for an unset required key, matching the real store", async () => {
		// Not a defect. `ActionState.get` is declared `Effect<A, ActionStateError>`
		// and answers `reason: "missing"` for a key no earlier phase saved, so code
		// whose contract is to degrade when nothing was persisted must be able to
		// catch it here too. The double dying instead made `resolveSignoff` — whose
		// declared error channel is `never` precisely because it catches this —
		// look broken while being correct against the real store.
		const Payload = Schema.Struct({ startedAt: Schema.Number });

		// `Effect.flip` moves the failure into the success channel, so this only
		// resolves if the miss arrived as a typed ERROR — a defect would still
		// reject, which is what makes the assertion discriminate.
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* ActionState;
				return yield* state.get("absent", Payload);
			}).pipe(Effect.provide(actionStateTestLayer(emptyActionState())), Effect.flip),
		);

		expect(error).toBeInstanceOf(ActionStateError);
		expect(error.reason).toBe("missing");
		expect(error.key).toBe("absent");
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

describe("fakeSha", () => {
	it("produces 40-character hex strings that differ by kind and number", () => {
		for (const sha of [fakeSha("head"), fakeSha("base", 10), fakeSha("head", 255)]) {
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		}
		expect(fakeSha("head", 1)).not.toBe(fakeSha("base", 1));
		expect(fakeSha("head", 1)).not.toBe(fakeSha("head", 2));
	});
});
