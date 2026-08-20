/**
 * Input-parsing tests for `readInputs`.
 *
 * These exist because of a shipped regression: `program.ts` read its inputs
 * with bare `Config.string(...)` after the kit migration. Under the runner,
 * GitHub exports `INPUT_DEPENDENCIES`; a bare `Config` read looks up the
 * literal name `dependencies`, finds nothing, and silently takes its
 * `withDefault`. Every input resolved to its default — including `dry-run`,
 * so a workflow asking to rehearse performed a live run.
 *
 * The old suite could not catch it twice over: nothing exercised `program`'s
 * input layer at all, and the input block sat under a `v8 ignore`. So the env
 * here is RUNNER-SHAPED (`INPUT_*`, mangled) and injected through
 * `ActionInput.layer`, never `process.env` — if someone reverts to bare
 * `Config`, every assertion below fails.
 *
 * @module program.inputs.test
 */

import { readFileSync } from "node:fs";
import { ActionInput } from "@effected/github-actions";
import { Cause, Effect, Exit, References, Result } from "effect";
import { describe, expect, it } from "vitest";
import { INPUT_NAMES, readInputs } from "../../../src/schema/inputs.js";

/**
 * The variables the runner actually exports: `INPUT_` + the input name
 * uppercased with spaces (not dashes) replaced. `upgrade-runtime-node` becomes
 * `INPUT_UPGRADE-RUNTIME-NODE` — the dash survives, which is itself a rule
 * worth pinning, since a consumer guessing `INPUT_UPGRADE_RUNTIME_NODE` reads
 * nothing.
 */
const runnerEnv = (inputs: Readonly<Record<string, string>>): Record<string, string> =>
	Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));

/**
 * The `field` an `InvalidInputError` names, or `null` for any other failure.
 *
 * Reaching into the cause is deliberate: asserting only that a read failed
 * cannot distinguish "rejected the right input" from "rejected a different one",
 * and a validation error that names the wrong field sends the reader to correct
 * configuration and tells them it is broken.
 */
const failedField = (exit: Exit.Exit<unknown, unknown>): string | null => {
	if (Exit.isSuccess(exit)) return null;
	const error = Cause.findError(exit.cause);
	if (!Result.isSuccess(error)) return null;
	const field = (error.success as { field?: unknown }).field;
	return typeof field === "string" ? field : null;
};

const read = (inputs: Readonly<Record<string, string>>) =>
	Effect.runPromiseExit(
		readInputs.pipe(
			Effect.provide(ActionInput.layer(runnerEnv(inputs))),
			Effect.provideService(References.MinimumLogLevel, "None"),
		),
	);

const readOrThrow = async (inputs: Readonly<Record<string, string>>) => {
	const exit = await read(inputs);
	if (Exit.isFailure(exit)) throw new Error(`readInputs failed: ${JSON.stringify(exit.cause)}`);
	return exit.value;
};

describe("readInputs — runner-shaped environment", () => {
	it("reads every configured input rather than falling back to defaults", async () => {
		// The exact shape of the workflow whose real run surfaced the bug.
		const result = await readOrThrow({
			dependencies: "effect\n@effect/platform\nvitest\ntypescript",
			"config-dependencies": "@savvy-web/pnpm-plugin-silk\n@effected/pnpm-plugin-effect",
			run: "pnpm lint\npnpm test",
			"upgrade-runtime-node": "^26.0.0",
			branch: "pnpm/config-deps",
		});

		expect(result.inputs.dependencies).toEqual(["effect", "@effect/platform", "vitest", "typescript"]);
		expect(result.inputs["config-dependencies"]).toEqual([
			"@savvy-web/pnpm-plugin-silk",
			"@effected/pnpm-plugin-effect",
		]);
		expect(result.inputs.run).toEqual(["pnpm lint", "pnpm test"]);
		expect(result.inputs.runtime.node).toBe("^26.0.0");
	});

	it("reads dry-run as true when the workflow sets it", async () => {
		// The most dangerous instance: defaulting here turns a rehearsal into a
		// live run that commits, pushes and opens a PR.
		const result = await readOrThrow({ dependencies: "effect", "dry-run": "true" });

		expect(result.dryRun).toBe(true);
	});

	it("reads a non-default upgrade-package-manager", async () => {
		// "false" IS the default now, so asserting it would pass even when the read
		// resolves nothing — the vacuous shape this suite exists to catch. "auto"
		// can only arrive from the workflow.
		const result = await readOrThrow({ dependencies: "effect", "upgrade-package-manager": "auto" });

		expect(result.inputs["upgrade-package-manager"]).toBe("auto");
	});

	it("reads changesets and timeout, which are typed rather than string inputs", async () => {
		const result = await readOrThrow({ dependencies: "effect", changesets: "false", timeout: "42" });

		expect(result.inputs.changesets).toBe(false);
		expect(result.timeout).toBe(42);
	});

	it("selects the live runtime resolver when runtime-data says so", async () => {
		const result = await readOrThrow({ dependencies: "effect", "runtime-data": "live" });

		expect(result.runtimeLive).toBe(true);
	});
});

describe("readInputs — defaults and absence", () => {
	it("applies defaults only for inputs the workflow genuinely omitted", async () => {
		const result = await readOrThrow({ dependencies: "effect" });

		expect(result.inputs.branch).toBe("pnpm/config-deps");
		expect(result.inputs.sourceBranch).toBe("main");
		expect(result.inputs["upgrade-package-manager"]).toBe("false");
		expect(result.dryRun).toBe(false);
		expect(result.timeout).toBe(180);
	});

	it("treats an empty target-branch as absent and follows source-branch", async () => {
		// The provider reads "" as absent, so withDefault("") applies and
		// resolveTargetBranch falls back to the source — the pre-migration net
		// behavior, preserved.
		const result = await readOrThrow({ dependencies: "effect", "source-branch": "dev", "target-branch": "" });

		expect(result.inputs.targetBranch).toBe("dev");
	});

	it("uses an explicit target-branch when one is given", async () => {
		const result = await readOrThrow({ dependencies: "effect", "source-branch": "dev", "target-branch": "main" });

		expect(result.inputs.targetBranch).toBe("main");
	});
});

describe("readInputs — validation", () => {
	it("fails loudly on a malformed boolean instead of silently defaulting", async () => {
		// The kit's documented improvement: `Config.withDefault` no longer
		// swallows an InvalidValue. A workflow typing `dry-run: yes` must stop,
		// not quietly perform the mutations it meant to rehearse.
		const exit = await read({ dependencies: "effect", "dry-run": "yes" });

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails when no update type is active", async () => {
		const exit = await read({ "upgrade-package-manager": "false" });

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails when peer-lock and peer-minor overlap", async () => {
		const exit = await read({ dependencies: "effect", "peer-lock": "effect", "peer-minor": "effect" });

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("rejects a glob in peer-lock, naming peer-lock", async () => {
		// `dependencies` entries ARE globs; peer entries are matched as exact
		// package names. A `@scope/*` in `peer-lock` therefore matched nothing at
		// all — and did so silently: the overlap check compares raw strings so it
		// never fired, and the run reported success having synced no peer ranges.
		// The only proportional signal for "this input did nothing" is rejection.
		const exit = await read({ dependencies: "@scope/*", "peer-lock": "@scope/*" });

		expect(Exit.isFailure(exit)).toBe(true);
		expect(failedField(exit)).toBe("peer-lock");
	});

	it("rejects a glob in peer-minor, naming peer-minor", async () => {
		// The `field` assertion is the point, not the failure. The first version of
		// this validation merged both lists and hardcoded `field: "peer-lock"`, so
		// a glob in `peer-minor` alone sent the reader to an input that was
		// correct. `Exit.isFailure` alone passes against that bug — which is why
		// the three tests shipped with it, including a control, all went green.
		const exit = await read({ dependencies: "effect*", "peer-minor": "effect*" });

		expect(Exit.isFailure(exit)).toBe(true);
		expect(failedField(exit)).toBe("peer-minor");
	});

	it("accepts a literal scoped package name in peer-lock", async () => {
		// The control. Without it the rejection above is indistinguishable from a
		// pattern that rejects every scoped name — `@scope/pkg` contains no glob
		// metacharacter and must still be accepted.
		const exit = await read({ dependencies: "@scope/*", "peer-lock": "@scope/pkg" });

		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("fails on an unparseable semver range for a runtime input", async () => {
		const exit = await read({ dependencies: "effect", "upgrade-runtime-node": "not-a-range" });

		expect(Exit.isFailure(exit)).toBe(true);
	});
});

describe("readInputs — multi-value input grammar", () => {
	// These forms are THIS action's documented contract. `ActionInput.list`
	// absorbed the grammar our local parseMultiValueInput used to implement, so
	// the implementation is upstream now — but the contract is still ours, and a
	// silent upstream change to any row below is a consumer-visible break.
	it("accepts a JSON array", async () => {
		const r = await readOrThrow({ dependencies: '["effect","vitest"]' });
		expect(r.inputs.dependencies).toEqual(["effect", "vitest"]);
	});

	it("accepts dash bullets", async () => {
		const r = await readOrThrow({ dependencies: "- effect\n- vitest" });
		expect(r.inputs.dependencies).toEqual(["effect", "vitest"]);
	});

	it("accepts star bullets", async () => {
		// Our local parser stripped `*` and NOT `-`; the kit strips both. This row
		// is the one our old grammar had and the kit's earlier version did not.
		const r = await readOrThrow({ dependencies: "* effect\n* vitest" });
		expect(r.inputs.dependencies).toEqual(["effect", "vitest"]);
	});

	it("accepts comma-separated values", async () => {
		const r = await readOrThrow({ dependencies: "effect, vitest" });
		expect(r.inputs.dependencies).toEqual(["effect", "vitest"]);
	});

	it("drops whole-line # comments", async () => {
		const r = await readOrThrow({ dependencies: "# pinned set\neffect\nvitest" });
		expect(r.inputs.dependencies).toEqual(["effect", "vitest"]);
	});

	it("treats a bulleted #tag as a value, not a comment", async () => {
		// The comment check runs BEFORE bullet stripping, so `- #tag` is a value.
		const r = await readOrThrow({ dependencies: "- #tag\neffect" });
		expect(r.inputs.dependencies).toEqual(["#tag", "effect"]);
	});

	it("reads an absent multi-value input as an empty list", async () => {
		// list() FAILS on an absent (and on an empty-string) input, so the
		// withDefault([]) pipe is load-bearing: without it every workflow that
		// omits `run` or `peer-lock` would fail to parse its inputs at all.
		const r = await readOrThrow({ dependencies: "effect" });
		expect(r.inputs.run).toEqual([]);
		expect(r.inputs["peer-lock"]).toEqual([]);
	});

	it("reads an explicitly empty multi-value input as an empty list", async () => {
		const r = await readOrThrow({ dependencies: "effect", run: "" });
		expect(r.inputs.run).toEqual([]);
	});
});

describe("readInputs — enumerated inputs", () => {
	it("passes a valid auto-merge method through", async () => {
		const r = await readOrThrow({ dependencies: "effect", "auto-merge": "squash" });
		expect(r.inputs["auto-merge"]).toBe("squash");
	});

	it("treats an absent auto-merge as disabled", async () => {
		const r = await readOrThrow({ dependencies: "effect" });
		expect(r.inputs["auto-merge"]).toBe("");
	});

	it("fails on an unknown auto-merge method rather than casting it through", async () => {
		// Previously an unchecked cast, so a typo reached the GraphQL mutation as
		// an invalid enum instead of failing at input parsing.
		const exit = await read({ dependencies: "effect", "auto-merge": "sqush" });
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("reads runtime-data: live", async () => {
		const r = await readOrThrow({ dependencies: "effect", "runtime-data": "live" });
		expect(r.runtimeLive).toBe(true);
	});

	it("fails on an unknown runtime-data value rather than falling back to offline", async () => {
		// Falling back silently resolved runtime versions from the bundled snapshot
		// while the workflow had asked for live data.
		const exit = await read({ dependencies: "effect", "runtime-data": "offline-ish" });
		expect(Exit.isFailure(exit)).toBe(true);
	});
});

describe("check-peers", () => {
	// Opt-in by default, matching upgrade-package-manager and upgrade-runtime-*:
	// a `warn` default would add a peer computation and a PR-body section to
	// every consumer run nobody asked for.
	it('defaults to "false" when the input is absent', async () => {
		const result = await readOrThrow({ dependencies: "effect" });
		expect(result.inputs["check-peers"]).toBe("false");
	});

	it.each(["false", "warn", "no-auto-merge"])("accepts the keyword %s", async (value) => {
		const result = await readOrThrow({ dependencies: "effect", "check-peers": value });
		expect(result.inputs["check-peers"]).toBe(value);
	});

	// `fail` is a DEFERRED mode, not a supported one: it is the only tier that
	// needs a second concurrent check run. Accepting it now would silently do
	// nothing, which is worse than rejecting it.
	it.each(["fail", "true", "yes", "No-Auto-Merge"])("rejects %s, naming the field", async (value) => {
		const exit = await read({ dependencies: "effect", "check-peers": value });
		expect(failedField(exit)).toBe("check-peers");
	});

	// auto-merge is legitimately dynamic in a workflow expression, so the
	// combination must WARN rather than fail -- failing would break a valid
	// workflow whose auto-merge resolves to "" on some events.
	it("accepts no-auto-merge even when auto-merge is disabled", async () => {
		const result = await readOrThrow({
			dependencies: "effect",
			"check-peers": "no-auto-merge",
			"auto-merge": "",
		});
		expect(result.inputs["check-peers"]).toBe("no-auto-merge");
		expect(result.inputs["auto-merge"]).toBe("");
	});
});

describe("INPUT_NAMES", () => {
	/**
	 * The input names `action.yml` declares, read straight from the manifest.
	 *
	 * Narrow regex rather than a YAML dependency: the `inputs:` block is a flat
	 * map of `  <name>:` keys, and anchoring on the block keeps a nested
	 * `description:`/`default:` from being mistaken for an input.
	 */
	const manifestInputNames = (): ReadonlyArray<string> => {
		const yaml = readFileSync(new URL("../../../action.yml", import.meta.url), "utf-8");
		const block = /\ninputs:\n([\s\S]*?)(?=\noutputs:)/.exec(yaml);
		if (block === null) throw new Error("action.yml has no inputs: block");
		return [...block[1].matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
	};

	it("mirrors action.yml exactly", () => {
		// action.yml is the single source of input names; this tuple is a mirror,
		// and a mirror nobody checks is just a second source. The regression it
		// guards is an input added to the manifest and never read, or read under a
		// name the manifest does not declare — both of which resolve to a silent
		// default under the runner rather than failing.
		expect([...INPUT_NAMES].sort()).toEqual([...manifestInputNames()].sort());
	});
});
