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
import { GitHubMarkdown } from "@effected/github-actions";
import { PrBody } from "@savvy-web/silk-effects";
import { Context, Effect, Layer } from "effect";

import type {
	CatalogDelta,
	ChangesetFile,
	DependencyUpdateResult,
	PeerIssue,
	PullRequestResult,
} from "../schema/domain.js";
import { resolveSignoff } from "../utils/commit-signoff.js";
import { buildUpdateSubject } from "../utils/commit-subject.js";
import { bold, rule } from "../utils/markdown.js";

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
			peerIssues?: ReadonlyArray<PeerIssue>,
		) => Effect.Effect<PullRequestResult, GitHubError, Repo>;
		readonly generatePRBody: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			deltas?: ReadonlyArray<CatalogDelta>,
			peerIssues?: ReadonlyArray<PeerIssue>,
		) => string;
		readonly generateSummary: (
			updates: ReadonlyArray<DependencyUpdateResult>,
			changesets: ReadonlyArray<ChangesetFile>,
			pr: PullRequestResult | null,
			dryRun: boolean,
			deltas?: ReadonlyArray<CatalogDelta>,
		) => string;
		readonly generateCommitMessage: (updates: ReadonlyArray<DependencyUpdateResult>) => string;
	}
>()("Report") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 *
	 * The DCO sign-off is resolved **once, here**, and closed over by both
	 * renderings. `resolveSignoff` is an Effect over `ActionState` while the two
	 * consumers are a sync string builder and a method whose `R` must stay
	 * `Repo`-only, so the layer body is the one place it can be read without
	 * pushing `ActionState` into a member's requirement channel — the same
	 * "resolve dependencies in the layer" convention every other service here
	 * follows, and the convention the app-layer requirement guard depends on.
	 * It is also one state read per run rather than one per rendering, and it
	 * makes drift between the commit trailer and the PR body's proposed-squash
	 * fence structurally impossible rather than merely intended.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const pullRequest = yield* PullRequestTag;
			const signoff = yield* resolveSignoff();
			return {
				createOrUpdatePR: (branch, base, updates, changesets, autoMerge, deltas, peerIssues) =>
					createOrUpdatePRImpl(pullRequest, signoff, branch, base, updates, changesets, autoMerge, deltas, peerIssues),
				generatePRBody: generatePRBodyImpl,
				generateSummary: generateSummaryImpl,
				generateCommitMessage: (updates) => generateCommitMessageImpl(updates, signoff),
			};
		}),
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

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
	signoff: string,
	branch: string,
	base: string,
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	autoMerge?: "merge" | "squash" | "rebase",
	deltas?: ReadonlyArray<CatalogDelta>,
	peerIssues?: ReadonlyArray<PeerIssue>,
): Effect.Effect<PullRequestResult, GitHubError, Repo> =>
	Effect.gen(function* () {
		const title = buildUpdateSubject(updates);

		// Read the PR's current description BEFORE writing, so anything a human or
		// another agent wrote OUTSIDE the managed markers survives this run. A bare
		// `head` ref is qualified with this repo's owner by the kit, which is right
		// here because the update branch is always in this repository — the
		// fork-originated caveat on `list` cannot apply.
		const open = yield* pr.list({ head: branch, base, state: "open" });
		// `body` is optional-ABSENT on PullRequestInfo, not "" — GitHub sends
		// `body: null` for an empty description and the projection drops the key.
		// (ReleaseInfo and CommentRecord coalesce null to "" on a REQUIRED body;
		// PullRequestInfo is the odd one out. Coalescing here, not asserting "".)
		const priorBody = open[0]?.body ?? "";

		// Everything this action generates lives INSIDE the managed region and is
		// regenerated wholesale every run — the dependency tables describe the
		// current run, so carrying them forward would show stale versions. That is
		// why `summary` is fed this run's freshly rendered body rather than
		// `ManagedPrBody.extractSummary(priorBody)`: this repo has no curated
		// summary region to preserve, and manufacturing one would mean re-emitting
		// last run's tables. What `upsert` preserves, and what this adoption
		// actually adds, is the human prose outside the markers.
		const managed = PrBody.ManagedPrBody.build({
			subject: title,
			linkedIssues: [],
			// The same string `generateCommitMessage` trails, resolved once in the
			// layer — this fence is a *proposal* for the squash commit, so a
			// reviewer comparing it against the commit must not find two authors.
			signoff,
			summary: generatePRBodyImpl(updates, changesets, deltas, peerIssues),
			priorBody,
		});
		const body = PrBody.ManagedPrBody.upsert(priorBody, managed);

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
 * Generate the commit message for a dependency-update commit.
 *
 * The commit is created through the Git Data API with no explicit author, which
 * is what lets GitHub attribute and verify it; the `signoff` trailer is
 * supplied because that path bypasses `git commit -s`. It is passed in rather
 * than built here — see `utils/commit-signoff.ts` for whose identity it names
 * and `Report.layer` for why it is resolved once per run.
 */
const generateCommitMessageImpl = (updates: ReadonlyArray<DependencyUpdateResult>, signoff: string): string => {
	const subject = buildUpdateSubject(updates);

	return `${subject}

Updated dependencies:
${updates.map((u) => `- ${u.dependency}: ${u.from ?? "new"} -> ${u.to}`).join("\n")}

${signoff}`;
};

/**
 * Generate PR body with dependency changes (Dependabot-style formatting).
 */
const generatePRBodyImpl = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	deltas: ReadonlyArray<CatalogDelta> = [],
	peerIssues: ReadonlyArray<PeerIssue> = [],
): string => {
	// `GitHubMarkdown`'s statics are self-contained (no `this`), so destructuring
	// is safe. `bold`/`rule` come from `utils/markdown.js` — the two builders the
	// kit's writer does not ship.
	const { heading, table, link, code, details, codeBlock } = GitHubMarkdown;
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

	// Peer Dependencies - only when there is something to report. An empty
	// "no peer issues" section on every PR trains reviewers to skim past the
	// place the real finding will eventually appear.
	if (peerIssues.length > 0) {
		sections.push(heading("Peer Dependencies", 3));
		sections.push(
			table(
				["Package", "Importer", "Wanted", "Found", "Wanted by", "Required"],
				// Plain cells, matching the dependency tables above rather than
				// introducing a second linking convention in one document.
				peerIssues.map((issue) => [
					issue.dependency,
					issue.importer,
					issue.wanted,
					// `found: null` is the MISSING case. Rendering the raw null into
					// someone else's pull request would be this modelling decision
					// leaking out as a defect. `\u2014` is what the tables above
					// already use for an absent version.
					issue.found ?? "\u2014 not installed",
					issue.parents.join(" -> "),
					issue.optional ? "no" : "yes",
				]),
			),
		);
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
	const { heading, table, code, details, codeBlock, list, link } = GitHubMarkdown;
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
