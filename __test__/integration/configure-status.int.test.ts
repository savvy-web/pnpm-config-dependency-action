/**
 * Real-git integration test for `configureStatusStep`.
 *
 * **Why this is real IO rather than a scripted spawner.** The claim under test
 * is that a config write *takes effect on a later, independent command* — git's
 * own behavior, not ours. A scripted double would prove only that we issued a
 * command we chose to issue; whether git then honors it is the entire content
 * of the claim. A config write that silently did not take (wrong scope, wrong
 * key, wrong cwd) is indistinguishable from success at every seam except this
 * one.
 *
 * The failure it guards is silent by construction: without the setting, an
 * executable-bit flip is reported as a modification, the run decides it has
 * changes, and the API commit — which writes content at mode 100644 — produces
 * an empty tree. The result is an empty commit and a spurious PR, with nothing
 * in the logs to distinguish it from a real change.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Git } from "@effected/git";
import { Effect, Layer, References } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureStatusStep } from "../../src/steps/configure-status.js";

const gitLayer = Git.layer.pipe(Layer.provide(NodeServices.layer));

const run = <A, E>(effect: Effect.Effect<A, E, Git>) =>
	Effect.runPromise(effect.pipe(Effect.provide(gitLayer), Effect.provideService(References.MinimumLogLevel, "None")));

const git = (root: string, ...args: ReadonlyArray<string>) =>
	execFileSync("git", [...args], { cwd: root, encoding: "utf-8" });

describe("configureStatusStep", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "configure-status-"));
		git(root, "init", "--initial-branch=main");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		// The setting under test is what we are proving; start from git's own
		// default so the test is not accidentally passing on the environment's
		// pre-existing config.
		git(root, "config", "core.fileMode", "true");
		writeFileSync(join(root, "hook.sh"), "#!/bin/sh\necho hi\n", "utf-8");
		chmodSync(join(root, "hook.sh"), 0o644);
		git(root, "add", "-A");
		git(root, "commit", "-m", "base");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("suppresses an executable-bit-only change from git status", async () => {
		// Flip ONLY the exec bit. The content is byte-identical to HEAD, so this is
		// exactly the husky-chmod case that produced empty commits.
		chmodSync(join(root, "hook.sh"), 0o755);

		// Control: with git's default the change IS reported. Without this half the
		// test cannot distinguish "the config worked" from "git never saw a change
		// here in the first place" — which is how a no-op config write would pass.
		expect(git(root, "status", "--porcelain").trim()).not.toBe("");

		await run(configureStatusStep(root));

		expect(git(root, "status", "--porcelain").trim()).toBe("");
	});

	it("leaves a genuine content change visible", async () => {
		// The setting must suppress mode-only noise and nothing else. Without this
		// case, `core.fileMode=false` is indistinguishable from a change-blind
		// status read that suppresses everything.
		await run(configureStatusStep(root));
		writeFileSync(join(root, "hook.sh"), "#!/bin/sh\necho changed\n", "utf-8");

		expect(git(root, "status", "--porcelain").trim()).not.toBe("");
	});

	it("writes into the repository's own config, not the runner's global one", async () => {
		// `git config <key> <value>` with no scope flag is local scope. Asserting it
		// explicitly matters because a global write would appear to work here while
		// leaking a setting onto the runner for every later step in the job.
		await run(configureStatusStep(root));

		expect(git(root, "config", "--local", "core.fileMode").trim()).toBe("false");
	});
});
