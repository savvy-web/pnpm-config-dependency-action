import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptResult } from "@effected/commands";
import type { StatusEntry } from "@effected/git";
import { Git, UnknownRefError } from "@effected/git";
import type { FileChange, Repo } from "@effected/github";
import { GitBranch, GitCommit, GitHubError, RepoRef, Repo as RepoTag } from "@effected/github";
import { Effect, Layer, Option, References, Result } from "effect";
import { describe, expect, it } from "vitest";
import { BranchManager } from "../../../src/services/branch.js";
import { fromMap } from "../../utils/spawner.js";

/** Every resource method resolves `Repo` per call, so tests provide one. */
const repoLayer = RepoTag.layer(RepoRef.make({ owner: "test", repo: "repo" }));

interface BranchState {
	branches: Map<string, string>;
}

/**
 * A `GitBranch` double over an in-memory ref map.
 *
 * Only the members `BranchManager` reaches are stubbed — `sha`, `exists` and
 * `upsert`. Any other member dies naming itself, which is what proves the
 * service touches nothing else.
 */
const branchDouble = (state: BranchState, overrides: Parameters<typeof GitBranch.layerTest>[0] = {}) =>
	GitBranch.layerTest({
		sha: (name) => {
			const sha = state.branches.get(name);
			return sha === undefined
				? Effect.fail(new GitHubError({ kind: "notFound", operation: "git.getRef", reason: "Branch not found" }))
				: Effect.succeed(sha);
		},
		exists: (name) => Effect.succeed(state.branches.has(name)),
		upsert: (name, sha) =>
			Effect.sync(() => {
				const existed = state.branches.has(name);
				state.branches.set(name, sha);
				return existed ? ("reset" as const) : ("created" as const);
			}),
		...overrides,
	});

interface RecordedCommit {
	branch: string;
	message: string;
	changes: ReadonlyArray<FileChange>;
}

interface CommitState {
	commits: Array<RecordedCommit>;
}

/** A `GitCommit` double recording what `commitFiles` was asked to write. */
const commitDouble = (state: CommitState) =>
	GitCommit.layerTest({
		commitFiles: ({ branch, message, changes }) =>
			Effect.sync(() => {
				state.commits.push({ branch, message, changes });
				return `commit-sha-${state.commits.length}`;
			}),
	});

/** One recorded call against the `Git` service double. */
interface GitCall {
	readonly member: string;
	readonly cwd: string;
	readonly args: Record<string, unknown>;
}

/**
 * Run an effect that uses BranchManager with test layers.
 *
 * Every local git operation goes through `Git` now (the module has no `Run`
 * path left), so the double records each call — member, cwd and arguments. The
 * `cwd` is recorded deliberately: `manage` and the post-commit sync used to run
 * at the process directory with no cwd at all (#266), and recording it is what
 * makes that regression expressible as a failing assertion.
 *
 * `mergeBaseOption` defaults to "a merge-base exists"; a test that needs the
 * recovery path overrides it.
 */
const runWithBranchManager = <A, E>(
	effect: Effect.Effect<A, E, BranchManager | Repo>,
	branches?: Map<string, string>,
	responses?: ReadonlyMap<string, ScriptResult>,
	statusEntries?: ReadonlyArray<StatusEntry>,
	gitOverrides: Partial<Parameters<typeof Git.layerTest>[0]> = {},
) => {
	const state: BranchState = { branches: new Map(branches ?? []) };
	const commitState: CommitState = { commits: [] };
	const spawner = fromMap(responses);
	const gitCalls: GitCall[] = [];
	const record = (member: string, cwd: string, args: Record<string, unknown> = {}) => {
		gitCalls.push({ member, cwd, args });
	};

	const gitLayer = Git.layerTest({
		status: (cwd: string) => {
			record("status", cwd);
			return Effect.succeed(statusEntries ?? []);
		},
		fetch: (cwd: string, options: { readonly ref: string; readonly remote?: string }) => {
			record("fetch", cwd, { ...options });
			return Effect.void;
		},
		fetchUnshallow: (cwd: string, options?: { readonly remote?: string }) => {
			record("fetchUnshallow", cwd, { ...options });
			return Effect.void;
		},
		branchCreate: (cwd: string, name: string, options?: Record<string, unknown>) => {
			record("branchCreate", cwd, { name, ...options });
			return Effect.void;
		},
		reset: (cwd: string, options?: Record<string, unknown>) => {
			record("reset", cwd, { ...options });
			return Effect.void;
		},
		isShallow: (cwd: string) => {
			record("isShallow", cwd);
			return Effect.succeed(false);
		},
		mergeBaseOption: (cwd: string, a: string, b: string) => {
			record("mergeBaseOption", cwd, { a, b });
			return Effect.succeed(Option.some("merge-base-sha"));
		},
		...gitOverrides,
	});

	const serviceLayer = BranchManager.layer.pipe(
		Layer.provide(Layer.mergeAll(branchDouble(state), commitDouble(commitState), spawner.layer, gitLayer)),
	);

	return {
		state,
		commitState,
		spawner,
		gitCalls,
		result: Effect.runPromise(
			Effect.result(effect).pipe(
				Effect.provide(Layer.merge(serviceLayer, repoLayer)),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		),
	};
};

describe("BranchManager.manage", () => {
	it("creates new branch when it does not exist", async () => {
		const branches = new Map([["main", "main-sha-123"]]);
		const { state, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "/ws", "main");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.branch).toBe("pnpm/config");
			expect(either.success.created).toBe(true);
			expect(either.success.upToDate).toBe(true);
			expect(either.success.baseRef).toBe("main");
		}
		// Branch should have been created in the test state
		expect(state.branches.get("pnpm/config")).toBe("main-sha-123");
	});

	it("resets existing branch to default branch", async () => {
		const branches = new Map([
			["main", "main-sha-456"],
			["pnpm/config", "old-sha"],
		]);
		const { state, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "/ws", "main");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.branch).toBe("pnpm/config");
			expect(either.success.created).toBe(false);
			expect(either.success.upToDate).toBe(true);
		}
		// Branch should have been recreated with main SHA
		expect(state.branches.get("pnpm/config")).toBe("main-sha-456");
	});

	it("propagates a failure from upsert", async () => {
		// The old delete-and-recreate had a tolerated delete failure; upsert has
		// no separate delete step, so the failure that remains is upsert's own and
		// it must NOT be swallowed — a branch that could not be reset means the
		// run would push onto stale state.
		const state = { branches: new Map([["main", "main-sha"]]) };
		const failingBranch = branchDouble(state, {
			upsert: () =>
				Effect.fail(new GitHubError({ kind: "rejected", operation: "git.updateRef", reason: "protected branch" })),
		});
		const spawner = fromMap();
		const serviceLayer = BranchManager.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					failingBranch,
					commitDouble({ commits: [] }),
					spawner.layer,
					Git.layerTest({ status: () => Effect.succeed([]) }),
				),
			),
		);

		const either = await Effect.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.manage("pnpm/config", "/ws", "main");
				}),
			).pipe(
				Effect.provide(Layer.merge(serviceLayer, repoLayer)),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect((either.failure as GitHubError).kind).toBe("rejected");
		}
	});

	it("defaults to 'main' when no default branch specified", async () => {
		const branches = new Map([["main", "sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "/ws");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.baseRef).toBe("main");
		}
	});
});

describe("BranchManager.commitChanges", () => {
	// The change list comes from `@effected/git`'s `status`, which models the two
	// porcelain columns separately and carries `origPath` for a rename. Every case
	// below is written as the typed entry git's own machine-readable output
	// produces, so what is under test is the mapping onto commit members — the
	// place all three historical bugs lived — rather than a parser we no longer own.
	const entry = (x: StatusEntry["x"], y: StatusEntry["y"], path: string, origPath?: string): StatusEntry =>
		(origPath === undefined ? { x, y, path } : { x, y, path, origPath }) as StatusEntry;

	it("commits modified files via the GitHub API", async () => {
		const responses = new Map<string, ScriptResult>([
			["git fetch origin pnpm/config", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/pnpm/config", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("chore: update deps", "pnpm/config", process.cwd());
			}),
			undefined,
			responses,
			[entry(" ", "M", "package.json")],
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// commitFiles is a single call in the kit: tree, commit and ref update all
		// happen behind it, so the assertion is on what it was asked to write.
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].message).toBe("chore: update deps");
		expect(commitState.commits[0].branch).toBe("pnpm/config");
		expect(commitState.commits[0].changes).toEqual([
			{ _tag: "FileContent", path: "package.json", content: expect.any(String) },
		]);
	});

	it("records a deletion as a FileDeletion member", async () => {
		const responses = new Map<string, ScriptResult>([
			["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("update", "branch", process.cwd());
			}),
			undefined,
			responses,
			[entry("D", " ", "deleted-file.ts")],
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// A deletion is its own tagged member now, not a `sha: null` sentinel.
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].changes).toEqual([{ _tag: "FileDeletion", path: "deleted-file.ts" }]);
	});

	it("records a deletion whose two columns disagree", async () => {
		// Regression: the old parser tested the trimmed two-character field against
		// "D", which missed `AD` and `RD` entirely — the path was treated as a
		// modification, the read failed, and the change was dropped with a warning.
		// `D` in EITHER column means the path is gone in the state being committed.
		const responses = new Map<string, ScriptResult>([
			["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("update", "branch", process.cwd());
			}),
			undefined,
			responses,
			[entry("A", "D", "added-then-deleted.ts")],
		);

		expect(Result.isSuccess(await result)).toBe(true);
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].changes).toEqual([{ _tag: "FileDeletion", path: "added-then-deleted.ts" }]);
	});

	it("does not delete a copy's origin", async () => {
		// A copy carries an origin exactly like a rename does, but the origin still
		// exists on disk. Deleting it would remove a file the run never touched.
		const root = mkdtempSync(join(tmpdir(), "branch-copy-"));
		try {
			writeFileSync(join(root, "copy.ts"), "export const copied = 1;\n", "utf-8");

			const responses = new Map<string, ScriptResult>([
				["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
				["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
			]);

			const { commitState, result } = runWithBranchManager(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.commitChanges("chore: copy", "branch", root);
				}),
				undefined,
				responses,
				[entry("C", " ", "copy.ts", "src.ts")],
			);

			expect(Result.isSuccess(await result)).toBe(true);
			expect(commitState.commits).toHaveLength(1);
			expect(commitState.commits[0].changes).toEqual([
				{ _tag: "FileContent", path: "copy.ts", content: "export const copied = 1;\n" },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips unreadable files gracefully", async () => {
		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("update", "branch", process.cwd());
			}),
			undefined,
			undefined,
			[entry("M", " ", "nonexistent-file.ts")],
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// No commit should be created since no files could be read
		expect(commitState.commits).toHaveLength(0);
	});

	it("creates no commit when the working tree is clean", async () => {
		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("chore: update deps", "pnpm/config", process.cwd());
			}),
			undefined,
			undefined,
			[],
		);

		expect(Result.isSuccess(await result)).toBe(true);
		expect(commitState.commits).toHaveLength(0);
	});

	it("commits a renamed file as a delete of the old path plus content at the new one", async () => {
		// THE bug: the old parser produced the single path "old.ts -> new.ts", which
		// cannot be read from disk, so a renamed file silently never reached the
		// commit at all — the old file stayed and the new one never landed.
		const root = mkdtempSync(join(tmpdir(), "branch-rename-"));
		try {
			writeFileSync(join(root, "new.ts"), "export const moved = 1;\n", "utf-8");

			const responses = new Map<string, ScriptResult>([
				["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
				["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
			]);

			const { commitState, result } = runWithBranchManager(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.commitChanges("chore: move", "branch", root);
				}),
				undefined,
				responses,
				[entry("R", " ", "new.ts", "old.ts")],
			);

			expect(Result.isSuccess(await result)).toBe(true);
			expect(commitState.commits).toHaveLength(1);
			expect(commitState.commits[0].changes).toEqual([
				{ _tag: "FileDeletion", path: "old.ts" },
				{ _tag: "FileContent", path: "new.ts", content: "export const moved = 1;\n" },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads changed files from the workspace root it is given, not the process cwd", async () => {
		// Regression: commitChanges used to resolve every status path against
		// `process.cwd()` while every other step in the run reads and writes at the
		// DETECTED workspace root. The two are not the same thing — the action can
		// legitimately be invoked from a subdirectory — and when they diverged the
		// file read failed and the change was silently dropped with a warning.
		//
		// This test discriminates precisely because the file exists ONLY under the
		// temp root: resolving against `process.cwd()` cannot find it, so the buggy
		// path records zero commits while the fixed path records the content.
		const root = mkdtempSync(join(tmpdir(), "branch-root-"));
		try {
			writeFileSync(join(root, "package.json"), '{"name":"from-the-workspace-root"}\n', "utf-8");

			const responses = new Map<string, ScriptResult>([
				["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
				["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
			]);

			const { commitState, result } = runWithBranchManager(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.commitChanges("chore: update deps", "branch", root);
				}),
				undefined,
				responses,
				[entry(" ", "M", "package.json")],
			);

			const either = await result;

			expect(Result.isSuccess(either)).toBe(true);
			expect(commitState.commits).toHaveLength(1);
			expect(commitState.commits[0].changes).toEqual([
				{ _tag: "FileContent", path: "package.json", content: '{"name":"from-the-workspace-root"}\n' },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("BranchManager.validateBranches", () => {
	it("succeeds when both branches exist", async () => {
		const branches = new Map([
			["main", "main-sha"],
			["dev", "dev-sha"],
		]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "main");
			}),
			branches,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});

	it("succeeds when target equals source (skips redundant check)", async () => {
		const branches = new Map([["dev", "dev-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "dev");
			}),
			branches,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});

	it("fails with InvalidInputError when source branch is missing", async () => {
		const branches = new Map([["main", "main-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("nope", "main");
			}),
			branches,
		);
		const either = await result;
		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect(either.failure._tag).toBe("InvalidInputError");
			expect((either.failure as { field: string }).field).toBe("source-branch");
		}
	});

	it("fails with InvalidInputError when target branch is missing", async () => {
		const branches = new Map([["dev", "dev-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "main");
			}),
			branches,
		);
		const either = await result;
		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect(either.failure._tag).toBe("InvalidInputError");
			expect((either.failure as { field: string }).field).toBe("target-branch");
		}
	});
});

describe("BranchManager.ensureBaseHistory", () => {
	it("is a no-op when the merge-base already resolves (no fetch)", async () => {
		// The harness default is "a merge-base exists", so the recovery path must
		// not run. Asserting only success would prove nothing — every recovery call
		// is `Effect.ignore`d, so it succeeds either way. The assertion has to be
		// that no fetch/branchCreate was issued at all.
		const { gitCalls, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main", "/ws");
			}),
		);
		expect(Result.isSuccess(await result)).toBe(true);
		expect(gitCalls.map((c) => c.member)).toEqual(["mergeBaseOption"]);
	});

	it("treats an unknown base ref as 'not ready' rather than failing", async () => {
		// `mergeBaseOption` puts a missing ref on the ERROR channel and only a
		// missing common ancestor in `Option.none`. The preflight exists precisely
		// for the missing-ref case (single-branch or shallow checkout), so it must
		// recover rather than abort. Pins the behaviour, not the mechanism: the
		// catch-all in `hasMergeBase` is what carries it, and the compiler already
		// forces that catch to exist because the helper is typed `E = never`.
		const { gitCalls, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main", "/ws");
			}),
			undefined,
			undefined,
			undefined,
			{
				mergeBaseOption: () => Effect.fail(new UnknownRefError({ ref: "main", cwd: "/ws" })),
			},
		);
		expect(Result.isSuccess(await result)).toBe(true);
		// It recovered rather than aborting: the fetch path ran.
		expect(gitCalls.map((c) => c.member)).toContain("fetch");
	});

	it("fetches and deepens, then succeeds (warns) when the base is unavailable", async () => {
		// No merge-base → the fallback fetch/unshallow/branchCreate path runs and
		// the effect still succeeds (best-effort, non-fatal — it warns).
		const { gitCalls, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main", "/ws");
			}),
			undefined,
			undefined,
			undefined,
			{
				mergeBaseOption: () => Effect.succeedNone,
				isShallow: () => Effect.succeed(true),
			},
		);
		expect(Result.isSuccess(await result)).toBe(true);

		// The recovery is an ordered sequence, and each step depends on the last:
		// the refspec fetch materializes origin/<base>, unshallow deepens it, and
		// branchCreate makes the bare name resolve.
		const fetched = gitCalls.find((c) => c.member === "fetch");
		expect(fetched?.args.ref).toBe("+refs/heads/main:refs/remotes/origin/main");
		expect(gitCalls.map((c) => c.member)).toContain("fetchUnshallow");
		const created = gitCalls.find((c) => c.member === "branchCreate");
		expect(created?.args).toMatchObject({ name: "main", force: true, startPoint: "refs/remotes/origin/main" });
	});

	it("runs every git command at the workspace root, not the process cwd", async () => {
		// Regression, same defect class as the commitChanges cwd bug: every other
		// step reads and writes at `detected.root`, but this one ran git wherever the
		// process happened to be. The action can legitimately be invoked from a
		// subdirectory, and then the merge-base probe and the recovery fetches all
		// resolve against the wrong repository state.
		//
		// This asserts on the RECORDED cwd of every git call, not on which calls
		// were made — an assertion on command shape is cwd-blind and passes against
		// the buggy version. That blindness is why the bug survived a review and a
		// full suite.
		const { gitCalls, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main", "/some/workspace/root");
			}),
			undefined,
			undefined,
			undefined,
			{ mergeBaseOption: () => Effect.succeedNone, isShallow: () => Effect.succeed(true) },
		);

		expect(Result.isSuccess(await result)).toBe(true);
		// Guards the guard: zero recorded calls would pass the loop vacuously.
		expect(gitCalls.length).toBeGreaterThan(0);
		for (const call of gitCalls) {
			expect(call.cwd, `${call.member} ran at ${call.cwd}`).toBe("/some/workspace/root");
		}
	});
});

describe("BranchManager.manage — git plumbing", () => {
	it("fetches the branch by explicit refspec, not a bare `git fetch origin`", async () => {
		// A bare fetch honours the clone's configured refspec, which on a
		// single-branch checkout (actions/checkout's default) covers only the
		// checked-out branch — so origin/<branch> never materializes and the
		// checkout below it fails. Live runs masked this with fetch-depth: 0.
		//
		// Asserting only that `manage` SUCCEEDS proves nothing here — the double
		// answers every call happily. The assertion has to be on the ref actually
		// requested.
		const branches = new Map([["main", "main-sha"]]);
		const { gitCalls, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "/ws", "main");
			}),
			branches,
		);

		expect(Result.isSuccess(await result)).toBe(true);

		const fetched = gitCalls.find((c) => c.member === "fetch");
		expect(fetched?.args.ref).toBe("+refs/heads/pnpm/config:refs/remotes/origin/pnpm/config");
		expect(fetched?.args.remote).toBe("origin");
		// A bare ref here is the actual bug: it would read as valid and resolve
		// nothing on a single-branch clone.
		expect(fetched?.args.ref).not.toBe("pnpm/config");

		// `checkout -B` is branchCreate with force + checkout, same argv.
		const created = gitCalls.find((c) => c.member === "branchCreate");
		expect(created?.args).toMatchObject({
			name: "pnpm/config",
			checkout: true,
			force: true,
			startPoint: "origin/pnpm/config",
		});

		// And it must be anchored at the passed root, not the process cwd (#266).
		expect(fetched?.cwd).toBe("/ws");
		expect(created?.cwd).toBe("/ws");
	});
});
