/**
 * Action input parsing and validation.
 *
 * Uses Effect Schema for type-safe validation.
 *
 * @module inputs
 */

import { ActionInputs as ActionInputsTag } from "@savvy-web/github-action-effects";
import { Effect, Option, ParseResult, Schema } from "effect";

import { InvalidInputError } from "./schemas/errors.js";
import { ActionInputs } from "./schemas/index.js";

/**
 * Raw input structure from GitHub Actions.
 */
const RawActionInputs = Schema.Struct({
	appId: Schema.String,
	appPrivateKey: Schema.String,
	branch: Schema.String,
	configDependencies: Schema.Array(Schema.String),
	dependencies: Schema.Array(Schema.String),
	run: Schema.Array(Schema.String),
	updatePnpm: Schema.Boolean,
	changesets: Schema.Boolean,
	autoMerge: Schema.Literal("", "merge", "squash", "rebase"),
});

/**
 * Transform raw inputs into validated ActionInputs with custom validation.
 */
const ValidatedInputs = Schema.transformOrFail(RawActionInputs, ActionInputs, {
	strict: true,
	decode: (raw) => {
		// Validate at least one update type is specified
		if (raw.configDependencies.length === 0 && raw.dependencies.length === 0 && !raw.updatePnpm) {
			return ParseResult.fail(
				new ParseResult.Type(
					ActionInputs.ast,
					raw,
					"Must specify at least one of: config-dependencies, dependencies, or update-pnpm",
				),
			);
		}
		return ParseResult.succeed(raw);
	},
	encode: ParseResult.succeed,
});

/**
 * Read an optional string input, returning empty string if not set.
 */
const getOptionalString = (inputs: ActionInputsTag, name: string): Effect.Effect<string, InvalidInputError> =>
	inputs.getOptional(name, Schema.String).pipe(Effect.map((opt) => Option.getOrElse(opt, () => "")));

/**
 * Parse and validate action inputs using Effect Schema.
 */
export const parseInputs: Effect.Effect<ActionInputs, InvalidInputError, ActionInputsTag> = Effect.gen(function* () {
	const inputs = yield* ActionInputsTag;

	// Gather raw inputs from the ActionInputs service
	const rawInputs = {
		appId: yield* inputs.get("app-id", Schema.String),
		appPrivateKey: yield* inputs.getSecret("app-private-key", Schema.String),
		branch: (yield* getOptionalString(inputs, "branch")) || "pnpm/config-deps",
		configDependencies: parseMultilineInput(yield* getOptionalString(inputs, "config-dependencies")),
		dependencies: parseMultilineInput(yield* getOptionalString(inputs, "dependencies")),
		run: parseMultilineInput(yield* getOptionalString(inputs, "run")),
		updatePnpm: yield* inputs.getBooleanOptional("update-pnpm", true),
		changesets: yield* inputs.getBooleanOptional("changesets", true),
		autoMerge: ((yield* getOptionalString(inputs, "auto-merge")) || "") as "" | "merge" | "squash" | "rebase",
	};

	// Decode and validate using schema
	const result = yield* Schema.decodeUnknown(ValidatedInputs)(rawInputs).pipe(
		Effect.mapError((parseError) => {
			// Convert ParseError to InvalidInputError
			const issue = parseError.issue;
			const field = getFieldFromParseIssue(issue);
			const reason = getReasonFromParseIssue(issue);

			return new InvalidInputError({
				field: field || "unknown",
				value: field === "appPrivateKey" ? "[REDACTED]" : rawInputs[field as keyof typeof rawInputs],
				reason,
			});
		}),
	);

	const dryRun = yield* inputs.getBooleanOptional("dry-run", false);

	yield* Effect.logInfo(
		`Parsed inputs: branch=${result.branch}, configDeps=${result.configDependencies.length}, deps=${result.dependencies.length}, run=${result.run.length}, updatePnpm=${result.updatePnpm}, changesets=${result.changesets}, autoMerge=${result.autoMerge || "disabled"}, dryRun=${dryRun}`,
	);

	return result;
});

/**
 * Extract field name from a ParseIssue.
 */
export const getFieldFromParseIssue = (issue: ParseResult.ParseIssue): string => {
	if ("path" in issue && Array.isArray(issue.path) && issue.path.length > 0) {
		const firstPathSegment = issue.path[0];
		if (typeof firstPathSegment === "object" && "key" in firstPathSegment) {
			return String(firstPathSegment.key);
		}
	}
	return "input";
};

/**
 * Extract human-readable reason from a ParseIssue.
 */
export const getReasonFromParseIssue = (issue: ParseResult.ParseIssue): string => {
	if ("message" in issue && typeof issue.message === "string") {
		return issue.message;
	}
	if (issue._tag === "Missing") {
		return "This field is required";
	}
	if (issue._tag === "Type") {
		return `Expected valid value but got: ${JSON.stringify(issue.actual)}`;
	}
	return "Validation failed";
};

/**
 * Parse a multiline input string into an array of trimmed, non-empty lines.
 */
export const parseMultilineInput = (input: string): ReadonlyArray<string> => {
	if (!input || input.trim().length === 0) {
		return [];
	}

	return input
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
};
