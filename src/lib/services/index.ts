/**
 * Effect service definitions for the action.
 *
 * @module services
 */

import { context as ghContext } from "@actions/github";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Octokit } from "@octokit/rest";
import { Context, Effect, Layer } from "effect";

import type { CheckRun, GitStatus, PRData, PullRequest } from "../../types/index.js";
import { GitError, GitHubApiError, PnpmError } from "../errors/types.js";

// ══════════════════════════════════════════════════════════════════════════════
// GitHub Client Service
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tree entry for creating a git tree.
 */
export interface TreeEntry {
	readonly path: string;
	readonly mode: "100644" | "100755" | "040000" | "160000" | "120000";
	readonly type: "blob" | "tree" | "commit";
	readonly content?: string;
	readonly sha?: string | null;
}

/**
 * GitHub API client service interface.
 */
export interface GitHubClientService {
	readonly octokit: Octokit;
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;

	readonly branchExists: (name: string) => Effect.Effect<boolean, GitHubApiError>;
	readonly createBranch: (name: string, sha: string) => Effect.Effect<void, GitHubApiError>;
	readonly deleteBranch: (name: string) => Effect.Effect<void, GitHubApiError>;
	readonly getBranchSha: (name: string) => Effect.Effect<string, GitHubApiError>;
	readonly updateBranchRef: (name: string, sha: string) => Effect.Effect<void, GitHubApiError>;

	readonly getCommit: (sha: string) => Effect.Effect<{ treeSha: string }, GitHubApiError>;
	readonly createTree: (baseTree: string, entries: ReadonlyArray<TreeEntry>) => Effect.Effect<string, GitHubApiError>;
	readonly createCommit: (
		message: string,
		tree: string,
		parents: ReadonlyArray<string>,
		author?: { name: string; email: string },
	) => Effect.Effect<string, GitHubApiError>;

	readonly createCheckRun: (name: string) => Effect.Effect<CheckRun, GitHubApiError>;
	readonly updateCheckRun: (
		id: number,
		status: CheckRun["status"],
		conclusion?: CheckRun["conclusion"],
		summary?: string,
	) => Effect.Effect<void, GitHubApiError>;

	readonly findPR: (head: string, base: string) => Effect.Effect<PullRequest | null, GitHubApiError>;
	readonly createPR: (data: PRData) => Effect.Effect<PullRequest, GitHubApiError>;
	readonly updatePR: (number: number, data: Partial<PRData>) => Effect.Effect<void, GitHubApiError>;
	readonly enableAutoMerge: (
		pullRequestId: string,
		mergeMethod: "MERGE" | "SQUASH" | "REBASE",
	) => Effect.Effect<void, GitHubApiError>;
}

/**
 * GitHub client service tag.
 */
export class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, GitHubClientService>() {}

/**
 * Create a live GitHubClient layer from a token.
 */
export const makeGitHubClientLayer = (token: string): Layer.Layer<GitHubClient> =>
	Layer.succeed(GitHubClient, {
		octokit: new Octokit({ auth: token }),
		owner: ghContext.repo.owner,
		repo: ghContext.repo.repo,
		sha: ghContext.sha,

		branchExists: (name) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					try {
						await octokit.rest.repos.getBranch({
							owner: ghContext.repo.owner,
							repo: ghContext.repo.repo,
							branch: name,
						});
						return true;
					} catch (e) {
						if ((e as { status?: number }).status === 404) return false;
						throw e;
					}
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "repos.getBranch",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		createBranch: (name, sha) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.rest.git.createRef({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						ref: `refs/heads/${name}`,
						sha,
					});
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.createRef",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		deleteBranch: (name) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.rest.git.deleteRef({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						ref: `heads/${name}`,
					});
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.deleteRef",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		getBranchSha: (name) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data } = await octokit.rest.repos.getBranch({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						branch: name,
					});
					return data.commit.sha;
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "repos.getBranch",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		updateBranchRef: (name, sha) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.rest.git.updateRef({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						ref: `heads/${name}`,
						sha,
						force: true,
					});
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.updateRef",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		getCommit: (sha) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data } = await octokit.rest.git.getCommit({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						commit_sha: sha,
					});
					return { treeSha: data.tree.sha };
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.getCommit",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		createTree: (baseTree, entries) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data } = await octokit.rest.git.createTree({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						base_tree: baseTree,
						tree: entries.map((e) => ({
							path: e.path,
							mode: e.mode,
							type: e.type,
							content: e.content,
							sha: e.sha ?? undefined,
						})),
					});
					return data.sha;
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.createTree",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		createCommit: (message, tree, parents, _author) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					// NOTE: We do NOT pass author to the API call.
					// When using a GitHub App token, omitting the author allows
					// GitHub to attribute the commit to the app and sign it (verified).
					// Passing an explicit author prevents GitHub from signing the commit.
					const { data } = await octokit.rest.git.createCommit({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						message,
						tree,
						parents: [...parents],
					});
					return data.sha;
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "git.createCommit",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		createCheckRun: (name) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data } = await octokit.rest.checks.create({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						name,
						head_sha: ghContext.sha,
						status: "in_progress",
						started_at: new Date().toISOString(),
					});
					return { id: data.id, name, status: "in_progress" as const };
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "checks.create",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		updateCheckRun: (id, status, conclusion, summary) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.rest.checks.update({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						check_run_id: id,
						status,
						conclusion,
						completed_at: status === "completed" ? new Date().toISOString() : undefined,
						output: summary ? { title: conclusion ?? "Update", summary } : undefined,
					});
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "checks.update",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		findPR: (head, base) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data } = await octokit.rest.pulls.list({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						head: `${ghContext.repo.owner}:${head}`,
						base,
						state: "open",
					});
					if (data.length === 0) return null;
					return { number: data[0].number, url: data[0].html_url, created: false, nodeId: data[0].node_id };
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "pulls.list",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		createPR: (data) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					const { data: pr } = await octokit.rest.pulls.create({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						...data,
					});
					return { number: pr.number, url: pr.html_url, created: true, nodeId: pr.node_id };
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "pulls.create",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		updatePR: (number, data) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.rest.pulls.update({
						owner: ghContext.repo.owner,
						repo: ghContext.repo.repo,
						pull_number: number,
						...data,
					});
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "pulls.update",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),

		enableAutoMerge: (pullRequestId, mergeMethod) =>
			Effect.tryPromise({
				try: async () => {
					const octokit = new Octokit({ auth: token });
					await octokit.graphql(
						`mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
							enablePullRequestAutoMerge(input: {
								pullRequestId: $pullRequestId
								mergeMethod: $mergeMethod
							}) {
								pullRequest {
									autoMergeRequest {
										enabledAt
									}
								}
							}
						}`,
						{ pullRequestId, mergeMethod },
					);
				},
				catch: (e) =>
					new GitHubApiError({
						operation: "enablePullRequestAutoMerge",
						statusCode: (e as { status?: number }).status,
						message: String(e),
					}),
			}),
	});

// ══════════════════════════════════════════════════════════════════════════════
// Git Executor Service
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Git command executor service interface.
 */
export interface GitExecutorService {
	readonly checkout: (branch: string, create?: boolean) => Effect.Effect<void, GitError>;
	readonly checkoutTrack: (branch: string) => Effect.Effect<void, GitError>;
	readonly fetch: (remote?: string) => Effect.Effect<void, GitError>;
	readonly rebase: (onto: string) => Effect.Effect<void, GitError>;
	readonly commit: (message: string, signoff?: boolean) => Effect.Effect<void, GitError>;
	readonly push: (branch: string, force?: boolean) => Effect.Effect<void, GitError>;
	readonly status: () => Effect.Effect<GitStatus, GitError>;
	readonly add: (paths: ReadonlyArray<string>) => Effect.Effect<void, GitError>;
	readonly configUser: (name: string, email: string) => Effect.Effect<void, GitError>;
}

/**
 * Git executor service tag.
 */
export class GitExecutor extends Context.Tag("GitExecutor")<GitExecutor, GitExecutorService>() {}

/**
 * Execute a git command and capture output.
 */
const execGit = (args: ReadonlyArray<string>, operation: GitError["operation"]): Effect.Effect<string, GitError> =>
	Effect.gen(function* () {
		const command = Command.make("git", ...args);
		const result = yield* Command.string(command).pipe(
			Effect.provide(NodeContext.layer),
			Effect.mapError(
				(e) =>
					new GitError({
						operation,
						exitCode: "exitCode" in e ? (e.exitCode as number) : 1,
						stderr: "stderr" in e ? String(e.stderr) : String(e),
					}),
			),
		);
		return result;
	});

/**
 * Live Git executor layer.
 */
export const GitExecutorLive: Layer.Layer<GitExecutor> = Layer.succeed(GitExecutor, {
	checkout: (branch, create = false) =>
		execGit(create ? ["checkout", "-b", branch] : ["checkout", branch], "checkout").pipe(Effect.asVoid),

	checkoutTrack: (branch) =>
		// Use -B to create/reset the branch and track the remote
		execGit(["checkout", "-B", branch, `origin/${branch}`], "checkout").pipe(Effect.asVoid),

	fetch: (remote = "origin") => execGit(["fetch", remote], "fetch").pipe(Effect.asVoid),

	rebase: (onto) => execGit(["rebase", onto], "rebase").pipe(Effect.asVoid),

	commit: (message, signoff = true) =>
		execGit(signoff ? ["commit", "-m", message, "--signoff"] : ["commit", "-m", message], "commit").pipe(Effect.asVoid),

	push: (branch, force = false) =>
		execGit(force ? ["push", "--force-with-lease", "origin", branch] : ["push", "origin", branch], "push").pipe(
			Effect.asVoid,
		),

	status: () =>
		Effect.gen(function* () {
			const output = yield* execGit(["status", "--porcelain"], "status");
			const lines = output.split("\n").filter((l) => l.trim().length > 0);

			const staged: string[] = [];
			const unstaged: string[] = [];
			const untracked: string[] = [];

			for (const line of lines) {
				const status = line.substring(0, 2);
				const file = line.substring(3);

				if (status.startsWith("?")) {
					untracked.push(file);
				} else if (status[0] !== " ") {
					staged.push(file);
				} else if (status[1] !== " ") {
					unstaged.push(file);
				}
			}

			return {
				hasChanges: lines.length > 0,
				staged,
				unstaged,
				untracked,
			};
		}),

	add: (paths) => execGit(["add", ...paths], "status").pipe(Effect.asVoid),

	configUser: (name, email) =>
		Effect.gen(function* () {
			yield* execGit(["config", "user.name", name], "status");
			yield* execGit(["config", "user.email", email], "status");
		}),
});

// ══════════════════════════════════════════════════════════════════════════════
// Pnpm Executor Service
// ══════════════════════════════════════════════════════════════════════════════

/**
 * pnpm command executor service interface.
 */
export interface PnpmExecutorService {
	readonly addConfig: (dependency: string) => Effect.Effect<string, PnpmError>;
	readonly update: (pattern: string) => Effect.Effect<string, PnpmError>;
	readonly install: () => Effect.Effect<void, PnpmError>;
	readonly run: (command: string) => Effect.Effect<string, PnpmError>;
}

/**
 * pnpm executor service tag.
 */
export class PnpmExecutor extends Context.Tag("PnpmExecutor")<PnpmExecutor, PnpmExecutorService>() {}

/**
 * Execute a pnpm command and capture output.
 */
const execPnpm = (
	args: ReadonlyArray<string>,
	command: string,
	dependency?: string,
): Effect.Effect<string, PnpmError> =>
	Effect.gen(function* () {
		const cmd = Command.make("pnpm", ...args);
		const result = yield* Command.string(cmd).pipe(
			Effect.provide(NodeContext.layer),
			Effect.mapError(
				(e) =>
					new PnpmError({
						command,
						dependency,
						exitCode: "exitCode" in e ? (e.exitCode as number) : 1,
						stderr: "stderr" in e ? String(e.stderr) : String(e),
					}),
			),
		);
		return result;
	});

/**
 * Execute an arbitrary shell command.
 */
const execShell = (command: string): Effect.Effect<string, PnpmError> =>
	Effect.gen(function* () {
		// Use sh -c to properly handle shell commands
		const cmd = Command.make("sh", "-c", command);
		const result = yield* Command.string(cmd).pipe(
			Effect.provide(NodeContext.layer),
			Effect.mapError(
				(e) =>
					new PnpmError({
						command,
						exitCode: "exitCode" in e ? (e.exitCode as number) : 1,
						stderr: "stderr" in e ? String(e.stderr) : String(e),
					}),
			),
		);
		return result;
	});

/**
 * Live pnpm executor layer.
 */
export const PnpmExecutorLive: Layer.Layer<PnpmExecutor> = Layer.succeed(PnpmExecutor, {
	addConfig: (dependency) => execPnpm(["add", "--config", dependency], "add --config", dependency),

	update: (pattern) => execPnpm(["up", pattern, "--latest"], "up --latest", pattern),

	install: () => execPnpm(["install"], "install").pipe(Effect.asVoid),

	run: (command) => execShell(command),
});

// ══════════════════════════════════════════════════════════════════════════════
// Combined Application Layer
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create the combined application layer with all services.
 */
export const makeAppLayer = (token: string): Layer.Layer<GitHubClient | GitExecutor | PnpmExecutor> =>
	Layer.mergeAll(makeGitHubClientLayer(token), GitExecutorLive, PnpmExecutorLive);
