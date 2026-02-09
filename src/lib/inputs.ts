/**
 * Action input parsing and validation.
 *
 * Uses Effect Schema for type-safe validation.
 *
 * @module inputs
 */

import { getBooleanInput, getInput } from "@actions/core";
import { Effect, ParseResult, Schema } from "effect";

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
 * Parse and validate action inputs using Effect Schema.
 */
export const parseInputs: Effect.Effect<ActionInputs, InvalidInputError> = Effect.gen(function* () {
	// Gather raw inputs from GitHub Actions
	const rawInputs = {
		appId: getInput("app-id", { required: true }),
		appPrivateKey: getInput("app-private-key", { required: true }),
		branch: getInput("branch") || "pnpm/config-deps",
		configDependencies: parseMultilineInput(getInput("config-dependencies")),
		dependencies: parseMultilineInput(getInput("dependencies")),
		run: parseMultilineInput(getInput("run")),
		updatePnpm: getBooleanInput("update-pnpm") ?? true,
		autoMerge: (getInput("auto-merge") || "") as "" | "merge" | "squash" | "rebase",
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

	const dryRun = isDryRun();

	yield* Effect.logInfo(
		`Parsed inputs: branch=${result.branch}, configDeps=${result.configDependencies.length}, deps=${result.dependencies.length}, run=${result.run.length}, updatePnpm=${result.updatePnpm}, autoMerge=${result.autoMerge || "disabled"}, dryRun=${dryRun}`,
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

/**
 * Get optional GitHub token input (for GitHub Packages auth).
 */
export const getGitHubToken = (): string | undefined => {
	const token = getInput("github-token");
	return token && token.trim().length > 0 ? token : undefined;
};

/**
 * Check if running in dry-run mode.
 */
export const isDryRun = (): boolean => {
	return getBooleanInput("dry-run") || false;
};

/**
 * Check if token revocation should be skipped.
 */
export const shouldSkipTokenRevoke = (): boolean => {
	return getBooleanInput("skip-token-revoke") || false;
};

/**
 * Log level for the action.
 */
export type LogLevel = "info" | "debug";

/**
 * Get the configured log level.
 */
export const getLogLevel = (): LogLevel => {
	const level = getInput("log-level") || "info";
	return level === "debug" ? "debug" : "info";
};

/**
 * Check if debug logging is enabled.
 */
export const isDebugMode = (): boolean => {
	return getLogLevel() === "debug";
};
