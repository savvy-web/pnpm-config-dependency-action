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
	const depCount = updates.filter((u) => u.type === "dependency").length;
	const devCount = updates.filter((u) => u.type === "devDependency").length;
	const peerCount = updates.filter((u) => u.type === "peerDependency").length;

	const parts: string[] = [];
	if (configCount > 0) parts.push(`${configCount} config`);
	if (depCount > 0) parts.push(`${depCount} dependency`);
	if (devCount > 0) parts.push(`${devCount} dev`);
	if (peerCount > 0) parts.push(`${peerCount} peer`);

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

	sections.push(heading("Dependency Updates", 2));

	// Group updates by package
	const byPackage = new Map<string, DependencyUpdateResult[]>();
	for (const update of updates) {
		const key = update.package ?? "(root)";
		const existing = byPackage.get(key) ?? [];
		existing.push(update);
		byPackage.set(key, existing);
	}

	for (const [pkgName, pkgUpdates] of byPackage) {
		const label = pkgName === "(root)" ? "root workspace" : pkgName;
		sections.push(heading(label, 3));

		const rows = pkgUpdates.map((u) => [
			u.dependency,
			u.type,
			u.from === null ? "added" : "updated",
			u.from ?? "\u2014",
			u.to,
		]);
		sections.push(table(["Dependency", "Type", "Action", "From", "To"], rows));
	}

	// Changesets section - one expandable per affected package/workspace
	if (changesets.length > 0) {
		sections.push(heading("Changesets", 3));
		sections.push(`${changesets.length} changeset(s) created for version management.`);
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const csLabel = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const content = [
				`${bold("Changeset:")} ${code(cs.id)}`,
				`${bold("Type:")} ${cs.type}`,
				"",
				codeBlock(cs.summary),
			].join("\n");
			sections.push(details(csLabel, content));
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
	const { heading, table, code, details, codeBlock, bold, list, link } = GithubMarkdown;
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

	// Updated dependencies - grouped by package
	sections.push(heading("Updated Dependencies", 3));

	const byPackage = new Map<string, DependencyUpdateResult[]>();
	for (const update of updates) {
		const key = update.package ?? "(root)";
		const existing = byPackage.get(key) ?? [];
		existing.push(update);
		byPackage.set(key, existing);
	}

	for (const [pkgName, pkgUpdates] of byPackage) {
		const label = pkgName === "(root)" ? "root workspace" : pkgName;
		sections.push(heading(label, 4));

		const rows = pkgUpdates.map((u) => [
			code(u.dependency),
			u.type,
			u.from === null ? "added" : "updated",
			u.from ?? "\u2014",
			u.to,
		]);
		sections.push(table(["Dependency", "Type", "Action", "From", "To"], rows));
	}

	// Show changeset details - one expandable per affected package/workspace
	if (changesets.length > 0) {
		sections.push(heading("Changesets Created", 3));
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const csLabel = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const content = [`${bold("Changeset:")} ${code(cs.id)}`, "", codeBlock(cs.summary)].join("\n");
			sections.push(details(csLabel, content));
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
