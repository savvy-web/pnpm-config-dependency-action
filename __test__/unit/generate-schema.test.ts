import { NodeServices } from "@effect/platform-node";
import { SchemaFile, SchemaPipeline, SchemaValidator } from "@effected/schemastore";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { targets } from "../../lib/scripts/generate-schema.js";

/**
 * Drift guard for the committed JSON Schema.
 *
 * A generated artifact with no drift test is a lie waiting to happen: the day
 * someone edits `RunResultDocument` and forgets `pnpm generate-schema`, the
 * committed document silently describes a shape the action no longer emits, and
 * every editor and consumer validating against it is wrong in a way nothing
 * reports.
 *
 * **This imports the generator's own exported `targets`.** That is the whole
 * point — a test that rebuilt its own target list would pass while the generator
 * wrote something else entirely, which is a drift test that cannot detect drift.
 *
 * `SchemaPipeline.check` is the identical walk to `SchemaPipeline.run` without
 * the write, so what is asserted here is exactly what the generator would do.
 */

const AppLayer = Layer.mergeAll(SchemaFile.layer, SchemaValidator.layer).pipe(Layer.provide(NodeServices.layer));

const check = () => Effect.runPromise(SchemaPipeline.check(targets).pipe(Effect.provide(AppLayer)));

describe("generated JSON Schema", () => {
	it("has a target for every document the action publishes", () => {
		// Guards the empty-array degenerate case: `check([])` trivially reports no
		// drift, so a targets list that lost its entry would pass every assertion
		// below while checking nothing at all.
		expect(targets.length).toBeGreaterThan(0);
	});

	it("is not stale — regenerating would not change the committed file", async () => {
		const results = await check();

		for (const result of results) {
			expect(
				result.wouldWrite,
				`${result.path} is out of date (change: ${result.change}). Run \`pnpm generate-schema\` and commit the result.`,
			).toBe(false);
		}
	});

	it("would pass the generator's gate", async () => {
		// `wouldWrite: false` alone is not enough: a document that could never be
		// written — because its findings block the gate — would also report no
		// pending write. The package exposes `blocked` precisely so a
		// permanently-ungeneratable schema is not mistaken for a clean one.
		const results = await check();

		for (const result of results) {
			const blocking = result.findings.filter((f) => f.severity === "warning");
			expect(result.blocked, `${result.path} would fail the gate: ${blocking.map((f) => f.message).join("; ")}`).toBe(
				false,
			);
		}
	});
});
