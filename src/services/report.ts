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

import type { GitHubError, GitHubGraphQLError, PullRequestShape, Repo } from "@effected/github";
import { PullRequest as PullRequestTag } from "@effected/github";
import { Context, Effect, Layer } from "effect";

import type { CatalogDelta, ChangesetFile, DependencyUpdateResult, PullRequestResult } from "../schemas/domain.js";
import { buildUpdateSubject } from "../utils/commit-subject.js";
import { GithubMarkdown } from "../utils/github-markdown.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Report extends Context.Service<
	Report,
	{
		readonly createOrUpdatePR: (
			branch: string,
			base: string,
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			autoMerge?: "merge" | "squash" | "rebase",
			deltas?: ReadonlyArray<CatalogDelta>,
		) => Effect.Effect<PullRequestResult, GitHubError, Repo>;
		readonly generatePRBody: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			deltas?: ReadonlyArray<CatalogDelta>,
		) => string;
		readonly generateSummary: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			pr: PullRequestResult | null,
			dryRun: boolean,
			deltas?: ReadonlyArray<CatalogDelta>,
		) => string;
		readonly generateCommitMessage: (updates: ReadonlyArray<DependencyUpdateResult>, appSlug?: string) => string;
	}
>()("Report") {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const ReportLive = Layer.effect(
	Report,
	Effect.gen(function* () {
		const pullRequest = yield* PullRequestTag;
		return {
			createOrUpdatePR: (branch, base, updates, changesets, autoMerge, deltas) =>
				createOrUpdatePRImpl(pullRequest, branch, base, updates, changesets, autoMerge, deltas),
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
 * Returns `PullRequestResult` on success, or `GitHubError` in the error channel.
 *
 * Auto-merge is a separate call in the kit (`setAutoMerge`, a GraphQL mutation)
 * rather than a field on the create call. Its failure is deliberately swallowed
 * to a warning: the repository may simply not have auto-merge enabled, and that
 * must not fail a run whose PR was created successfully.
 */
const createOrUpdatePRImpl = (
	pr: PullRequestShape,
	branch: string,
	base: string,
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	autoMerge?: "merge" | "squash" | "rebase",
	deltas?: ReadonlyArray<CatalogDelta>,
): Effect.Effect<PullRequestResult, GitHubError, Repo> =>
	Effect.gen(function* () {
		const title = buildUpdateSubject(updates);
		const body = generatePRBodyImpl(updates, changesets, deltas);

		const result = yield* pr.upsert({ head: branch, base, title, body });
		const info = result.pullRequest;

		const action = result.created ? "Created" : "Updated";
		yield* Effect.logInfo(`${action} PR #${info.number}: ${info.url}`);

		if (autoMerge) {
			yield* pr
				.setAutoMerge(info, autoMerge)
				.pipe(
					Effect.catch((error: GitHubGraphQLError) =>
						Effect.logWarning(`Could not enable auto-merge on PR #${info.number}: ${error.message}`),
					),
				);
		}

		return {
			number: info.number,
			url: info.url,
			created: result.created,
			nodeId: info.nodeId,
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
	const subject = buildUpdateSubject(updates);

	const botName = appSlug ? `${appSlug}[bot]` : "github-actions[bot]";
	const botEmail = appSlug
		? `${appSlug}[bot]@users.noreply.github.com`
		: "41898282+github-actions[bot]@users.noreply.github.com";

	return `${subject}

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
	deltas: ReadonlyArray<CatalogDelta> = [],
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

	// Catalog Changes - on a compat-catalog plugin bump this table is the actual
	// payload of the run. A "kept" delta means a user override survived the
	// merge, not a change, so it is excluded here.
	const changedDeltas = deltas.filter((d) => d.action !== "kept");
	if (changedDeltas.length > 0) {
		sections.push(heading("Catalog Changes", 3));
		const byCatalog = new Map<string, CatalogDelta[]>();
		for (const delta of changedDeltas) {
			const existing = byCatalog.get(delta.catalog) ?? [];
			existing.push(delta);
			byCatalog.set(delta.catalog, existing);
		}
		for (const [catalog, catalogDeltas] of byCatalog) {
			sections.push(heading(catalog === "default" ? "default catalog" : `${catalog} catalog`, 4));
			sections.push(
				table(
					["Dependency", "Action", "From", "To"],
					catalogDeltas.map((d) => [code(d.dependency), d.action, d.from ?? "\u2014", d.to ?? "\u2014"]),
				),
			);
		}
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
		`_This PR was automatically created by ${link("silk-update-action", "https://github.com/savvy-web/silk-update-action")}_`,
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
	deltas: ReadonlyArray<CatalogDelta> = [],
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

	// Catalog Changes - on a compat-catalog plugin bump this table is the actual
	// payload of the run. A "kept" delta means a user override survived the
	// merge, not a change, so it is excluded here.
	const changedDeltas = deltas.filter((d) => d.action !== "kept");
	if (changedDeltas.length > 0) {
		sections.push(heading("Catalog Changes", 3));
		const byCatalog = new Map<string, CatalogDelta[]>();
		for (const delta of changedDeltas) {
			const existing = byCatalog.get(delta.catalog) ?? [];
			existing.push(delta);
			byCatalog.set(delta.catalog, existing);
		}
		for (const [catalog, catalogDeltas] of byCatalog) {
			sections.push(heading(catalog === "default" ? "default catalog" : `${catalog} catalog`, 4));
			sections.push(
				table(
					["Dependency", "Action", "From", "To"],
					catalogDeltas.map((d) => [code(d.dependency), d.action, d.from ?? "\u2014", d.to ?? "\u2014"]),
				),
			);
		}
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
		sections.push(details("View PR body", generatePRBodyImpl(updates, changesets, deltas)));
	}

	return sections.join("\n\n");
};
