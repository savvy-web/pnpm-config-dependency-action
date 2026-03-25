/**
 * Report service for PR management and report generation.
 *
 * Handles creating/updating pull requests and generating commit messages,
 * PR bodies, and summary text for check runs and job summaries.
 *
 * Key fix: PR creation failures now propagate through the Effect error channel
 * as `PullRequestError` instead of returning a sentinel `{ number: 0, url: "" }`.
 *
 * @module services/report
 */

import type { PullRequestError } from "@savvy-web/github-action-effects";
import { GithubMarkdown, PullRequest as PullRequestTag } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

type PullRequestShape = Context.Tag.Service<typeof PullRequestTag>;

import type { ChangesetFile, DependencyUpdateResult, PullRequestResult } from "../schemas/domain.js";
import { cleanVersion, npmUrl } from "../utils/markdown.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Report extends Context.Tag("Report")<
	Report,
	{
		readonly createOrUpdatePR: (
			branch: string,
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			autoMerge?: "merge" | "squash" | "rebase",
		) => Effect.Effect<PullRequestResult, PullRequestError>;
		readonly generatePRBody: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
		) => string;
		readonly generateSummary: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			pr: PullRequestResult | null,
			dryRun: boolean,
		) => string;
		readonly generateCommitMessage: (updates: ReadonlyArray<DependencyUpdateResult>, appSlug?: string) => string;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const ReportLive = Layer.effect(
	Report,
	Effect.gen(function* () {
		const pullRequest = yield* PullRequestTag;
		return {
			createOrUpdatePR: (branch, updates, changesets, autoMerge) =>
				createOrUpdatePRImpl(pullRequest, branch, updates, changesets, autoMerge),
			generatePRBody: generatePRBodyImpl,
			generateSummary: generateSummaryImpl,
			generateCommitMessage: generateCommitMessageImpl,
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create or update the dependency update PR.
 *
 * Returns `PullRequestResult` on success, or `PullRequestError` in the error channel.
 */
const createOrUpdatePRImpl = (
	pr: PullRequestShape,
	branch: string,
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	autoMerge?: "merge" | "squash" | "rebase",
): Effect.Effect<PullRequestResult, PullRequestError> =>
	Effect.gen(function* () {
		const title = "chore(deps): update pnpm config dependencies";
		const body = generatePRBodyImpl(updates, changesets);

		const result = yield* pr.getOrCreate({
			head: branch,
			base: "main",
			title,
			body,
			autoMerge: autoMerge || false,
		});

		const action = result.created ? "Created" : "Updated";
		yield* Effect.logInfo(`${action} PR #${result.number}: ${result.url}`);

		return {
			number: result.number,
			url: result.url,
			created: result.created,
			nodeId: result.nodeId,
		};
	});

/**
 * Generate commit message for dependency updates.
 *
 * Uses the app slug to attribute the sign-off to the correct bot.
 * When commits are created via the GitHub API without an explicit author,
 * and include a matching sign-off footer, GitHub will verify/sign the commit.
 */
const generateCommitMessageImpl = (updates: ReadonlyArray<DependencyUpdateResult>, appSlug?: string): string => {
	const configCount = updates.filter((u) => u.type === "config").length;
	const regularCount = updates.filter((u) => u.type === "regular").length;

	const parts: string[] = [];
	if (configCount > 0) parts.push(`${configCount} config`);
	if (regularCount > 0) parts.push(`${regularCount} regular`);

	const botName = appSlug ? `${appSlug}[bot]` : "github-actions[bot]";
	const botEmail = appSlug
		? `${appSlug}[bot]@users.noreply.github.com`
		: "41898282+github-actions[bot]@users.noreply.github.com";

	return `chore(deps): update ${parts.join(" and ")} dependencies

Updated dependencies:
${updates.map((u) => `- ${u.dependency}: ${u.from ?? "new"} -> ${u.to}`).join("\n")}

Signed-off-by: ${botName} <${botEmail}>`;
};

/**
 * Generate PR body with dependency changes (Dependabot-style formatting).
 */
const generatePRBodyImpl = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
): string => {
	const { heading, table, link, code, details, codeBlock, bold, rule } = GithubMarkdown;
	const sections: string[] = [];

	const configUpdates = updates.filter((u) => u.type === "config");
	const regularUpdates = updates.filter((u) => u.type === "regular");

	// Title section
	sections.push(heading("Dependency Updates", 2));

	// Summary line
	const parts: string[] = [];
	if (configUpdates.length > 0) parts.push(`${configUpdates.length} config`);
	if (regularUpdates.length > 0) parts.push(`${regularUpdates.length} regular`);
	sections.push(`Updates ${parts.join(" and ")} ${parts.length > 1 ? "dependencies" : "dependency"}.`);

	// Config dependencies section
	if (configUpdates.length > 0) {
		sections.push(heading("Config Dependencies", 3));
		const rows = configUpdates.map((update) => [
			link(code(update.dependency), npmUrl(update.dependency)),
			cleanVersion(update.from) ?? "_new_",
			cleanVersion(update.to) ?? "",
		]);
		sections.push(table(["Package", "From", "To"], rows));
	}

	// Regular dependencies section
	if (regularUpdates.length > 0) {
		sections.push(heading("Regular Dependencies", 3));
		const rows = regularUpdates.map((update) => {
			const pkg = update.dependency.includes("*")
				? code(update.dependency)
				: link(code(update.dependency), npmUrl(update.dependency));
			return [pkg, update.from ?? "_new_", update.to];
		});
		sections.push(table(["Package", "From", "To"], rows));
	}

	// Changesets section - one expandable per affected package/workspace
	if (changesets.length > 0) {
		sections.push(heading("Changesets", 3));
		sections.push(`${changesets.length} changeset(s) created for version management.`);
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const content = [
				`${bold("Changeset:")} ${code(cs.id)}`,
				`${bold("Type:")} ${cs.type}`,
				"",
				codeBlock(cs.summary),
			].join("\n");
			sections.push(details(label, content));
		}
	}

	// Footer
	sections.push(rule());
	sections.push(
		`_This PR was automatically created by ${link("pnpm-config-dependency-action", "https://github.com/savvy-web/pnpm-config-dependency-action")}_`,
	);

	return sections.join("\n\n");
};

/**
 * Generate summary text for check run and job summary.
 */
const generateSummaryImpl = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	pr: PullRequestResult | null,
	dryRun: boolean,
): string => {
	const { heading, table, link, code, details, codeBlock, bold, list } = GithubMarkdown;
	const sections: string[] = [];

	// Summary stats
	sections.push(heading("Summary", 3));
	const stats = [
		`${bold("Dependencies updated:")} ${updates.length}`,
		`${bold("Changesets created:")} ${changesets.length}`,
	];
	if (pr) {
		stats.push(`${bold("Pull request:")} ${link(`#${pr.number}`, pr.url)}`);
	}
	sections.push(list(stats));

	// Updated dependencies tables
	sections.push(heading("Updated Dependencies", 3));

	const configUpdates = updates.filter((u) => u.type === "config");
	const regularUpdates = updates.filter((u) => u.type === "regular");

	if (configUpdates.length > 0) {
		sections.push(heading("Config Dependencies", 4));
		const rows = configUpdates.map((update) => [
			code(update.dependency),
			cleanVersion(update.from) ?? "_new_",
			cleanVersion(update.to) ?? "",
		]);
		sections.push(table(["Package", "From", "To"], rows));
	}

	if (regularUpdates.length > 0) {
		sections.push(heading("Regular Dependencies", 4));
		const rows = regularUpdates.map((update) => [code(update.dependency), update.from ?? "_new_", update.to]);
		sections.push(table(["Package", "From", "To"], rows));
	}

	// Show changeset details - one expandable per affected package/workspace
	if (changesets.length > 0) {
		sections.push(heading("Changesets Created", 3));
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const content = [`${bold("Changeset:")} ${code(cs.id)}`, "", codeBlock(cs.summary)].join("\n");
			sections.push(details(label, content));
		}
	}

	// In dry-run mode, show what the PR body would look like
	if (dryRun && updates.length > 0) {
		sections.push(heading("PR Body Preview", 3));
		sections.push("This is what the PR body would look like:");
		sections.push(details("View PR body", generatePRBodyImpl(updates, changesets)));
	}

	return sections.join("\n\n");
};
