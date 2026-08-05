/**
 * Generate the JSON Schema for the action's structured `result` output.
 *
 * @remarks
 * `RunResultDocument` in `src/schema/domain.ts` is the single source of truth.
 * This script serialises it to a SchemaStore-compatible document at
 * `docs/schema/run-result.schema.json`, which `action.yml`'s `result`
 * description points at.
 *
 * Everything below {@link targets} belongs to `@effected/schemastore`:
 * `SchemaPipeline.run` builds the document, runs the structural lint and the
 * shipped ajv strict-mode gate, fails with a `SchemaGateError` carrying every
 * blocking finding, and writes only what passes — through `CanonicalJson`, and
 * only when the document's **content** differs. This script supplies the target
 * and the log wording; the package deliberately never logs.
 *
 * Because the comparison is by content rather than bytes, the generated file
 * needs no formatter carve-out: a formatter reflowing it does not provoke a
 * rewrite on the next run.
 *
 * Gating uses the pipeline's default blocking predicate — `warning` severity
 * fails the run, since each such finding means a document that would be broken
 * for the editors it exists to serve. `advisory` findings survive the gate and
 * are logged here.
 *
 * **Location matters.** This lives in `lib/scripts/`, not `scripts/`, because
 * that path is cache-invalidating for turbo — a generated artifact whose
 * generator changes must not be served from a stale cache.
 *
 * Run via `pnpm generate-schema`. The committed output is guarded against drift
 * by `__test__/unit/generate-schema.test.ts`, which imports {@link targets} and
 * uses `SchemaPipeline.check` — the identical walk, without writing.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { SchemaFile, SchemaPipeline, SchemaTarget, SchemaValidator } from "@effected/schemastore";
import { Effect, Layer } from "effect";
import { RunResultDocument } from "../../src/schema/domain.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The canonical URL the generated document publishes itself under. */
export const RUN_RESULT_SCHEMA_URL =
	"https://raw.githubusercontent.com/savvy-web/silk-update-action/main/docs/schema/run-result.schema.json";

/**
 * The schema publication targets: one per emitted document.
 *
 * @remarks
 * **Exported so the drift test checks exactly the wiring the generator writes.**
 * A drift test that rebuilt its own target list would pass while the generator
 * emitted something else entirely — the shared constant is the whole point.
 *
 * `name` is only required for versioned catalog naming, which this unversioned
 * document does not use.
 */
export const targets: ReadonlyArray<SchemaTarget> = [
	SchemaTarget.make({
		schema: RunResultDocument,
		$id: RUN_RESULT_SCHEMA_URL,
		path: resolve(REPO_ROOT, "docs/schema/run-result.schema.json"),
	}),
];

const generate = Effect.gen(function* () {
	// The whole gate-and-write walk is the package's: it lints, runs the ajv gate,
	// fails with `SchemaGateError` carrying every blocking finding, and writes only
	// what passes. The default blocking predicate is `severity === "warning"`,
	// which is the policy we want.
	const results = yield* SchemaPipeline.run(targets);

	for (const result of results) {
		// Anything surviving the gate is advisory by definition.
		for (const finding of result.findings) {
			yield* Effect.logInfo(`${result.$id}: ${finding.label} at "${finding.path}" — ${finding.message}`);
		}
		// `change` classifies what actually differed: `"contract"` is a
		// consumer-visible break, `"annotations"` is documentation only — the
		// versioning signal for a published schema, reported for free.
		yield* Effect.log(
			result.outcome === "written" ? `Written (${result.change}): ${result.path}` : `Unchanged: ${result.path}`,
		);
	}
});

const AppLayer = Layer.mergeAll(SchemaFile.layer, SchemaValidator.layer).pipe(Layer.provide(NodeServices.layer));

// Guarded so the drift test can import `targets` without generating anything.
const invokedDirectly =
	process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
	await Effect.runPromise(generate.pipe(Effect.provide(AppLayer)));
}
