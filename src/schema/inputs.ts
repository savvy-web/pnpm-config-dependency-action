/**
 * The action's input contract: the declared names, and the one decoded read.
 *
 * `action.yml` is the single source of input names and defaults; this module
 * mirrors them as data so the mirror can be checked rather than assumed
 * (`__test__/unit/schema/inputs.test.ts` reads the manifest and compares).
 *
 * @module schema/inputs
 */

import { ActionInput } from "@effected/github-actions";
import { Range } from "@effected/semver";
import { Config, Effect } from "effect";
import { InvalidInputError } from "../errors/errors.js";
import { resolveTargetBranch } from "../utils/branch.js";
import { matchesPattern } from "../utils/deps.js";

/**
 * Every input declared in `action.yml`, in manifest order.
 *
 * A tuple rather than a loose array so {@link InputName} is the exact union of
 * declared names and a typo cannot typecheck.
 */
export const INPUT_NAMES = [
	"app-client-id",
	"app-private-key",
	"branch",
	"source-branch",
	"target-branch",
	"config-dependencies",
	"dependencies",
	"peer-lock",
	"peer-minor",
	"upgrade-package-manager",
	"upgrade-runtime-node",
	"upgrade-runtime-deno",
	"upgrade-runtime-bun",
	"runtime-data",
	"dry-run",
	"run",
	"changesets",
	"timeout",
	"auto-merge",
	"check-peers",
] as const;

/** A name this action is allowed to read. */
export type InputName = (typeof INPUT_NAMES)[number];

/**
 * How the peer-dependency check behaves when the installed graph has
 * unsatisfied peers.
 *
 * - `false` — do not run the check at all. The default, matching the opt-in
 *   posture of `upgrade-package-manager` and the `upgrade-runtime-*` inputs.
 * - `warn` — run and report, never gate.
 * - `no-auto-merge` — run, report, and withhold the separate `setAutoMerge`
 *   call so the PR still opens but cannot merge itself.
 *
 * `fail` is deliberately absent. It is the only tier needing a second,
 * concurrent check run, so it is deferred rather than accepted-and-ignored.
 */
export type CheckPeersMode = "false" | "warn" | "no-auto-merge";

/** Every value {@link CheckPeersMode} admits, for validation. */
export const CHECK_PEERS_MODES = ["false", "warn", "no-auto-merge"] as const;

/**
 * Inputs consumed by {@link innerProgram}, already parsed and validated by
 * {@link program}.
 */
export interface InnerProgramInputs {
	branch: string;
	sourceBranch: string;
	targetBranch: string;
	"config-dependencies": ReadonlyArray<string>;
	dependencies: ReadonlyArray<string>;
	"peer-lock": ReadonlyArray<string>;
	"peer-minor": ReadonlyArray<string>;
	"upgrade-package-manager": string;
	changesets: boolean;
	"auto-merge": "" | "merge" | "squash" | "rebase";
	"check-peers": CheckPeersMode;
	run: ReadonlyArray<string>;
	runtime: { node: string; deno: string; bun: string };
	/** `"offline"` | `"live"` — reported in the Run-context log line only. */
	runtimeData: string;
}

/**
 * Read and validate every action input.
 *
 * Split out of {@link program} so the input layer is reachable in-process: it
 * is the ONLY part of the program that can be exercised without the real
 * GitHub/layer wiring, and leaving it inline is what let a provider regression
 * ship green (see `program.inputs.test.ts`).
 *
 * Every read goes through `ActionInput`, never bare `Config`. `ActionInput`
 * derives the runner's mangled variable name (`dependencies` → `INPUT_DEPENDENCIES`)
 * and treats an empty string as absent; a bare `Config.string("dependencies")`
 * looks up the literal name `dependencies`, finds nothing under the runner's
 * environment and silently takes its `withDefault`. That failure is invisible:
 * every input resolves to its default and the action reports each step as
 * "not configured" while the workflow plainly configured it.
 */
export const readInputs = Effect.gen(function* () {
	const branch = yield* ActionInput.string("branch").pipe(Config.withDefault("pnpm/config-deps"));
	const sourceBranch = yield* ActionInput.string("source-branch").pipe(Config.withDefault("main"));
	const rawTargetBranch = yield* ActionInput.string("target-branch").pipe(Config.withDefault(""));
	const targetBranch = resolveTargetBranch(rawTargetBranch, sourceBranch);
	const configDependencies = yield* ActionInput.list("config-dependencies").pipe(
		Config.withDefault<ReadonlyArray<string>>([]),
	);
	const dependencies = yield* ActionInput.list("dependencies").pipe(Config.withDefault<ReadonlyArray<string>>([]));
	const peerLock = yield* ActionInput.list("peer-lock").pipe(Config.withDefault<ReadonlyArray<string>>([]));
	const peerMinor = yield* ActionInput.list("peer-minor").pipe(Config.withDefault<ReadonlyArray<string>>([]));
	const run = yield* ActionInput.list("run").pipe(Config.withDefault<ReadonlyArray<string>>([]));
	const upgradePackageManager = yield* ActionInput.string("upgrade-package-manager").pipe(Config.withDefault("false"));
	const changesets = yield* ActionInput.boolean("changesets").pipe(Config.withDefault(true));
	const rawAutoMerge = yield* ActionInput.string("auto-merge").pipe(Config.withDefault(""));
	// An empty value means "disabled"; anything else must name a real merge
	// method. Validated rather than cast, so a typo fails loudly here instead of
	// reaching the GraphQL mutation as an invalid enum.
	const AUTO_MERGE_METHODS = ["", "merge", "squash", "rebase"] as const;
	if (!(AUTO_MERGE_METHODS as ReadonlyArray<string>).includes(rawAutoMerge)) {
		yield* Effect.fail(
			new InvalidInputError({
				field: "auto-merge",
				reason: 'Expected "merge", "squash", "rebase", or an empty value to disable auto-merge',
				value: rawAutoMerge,
			}),
		);
	}
	const autoMerge = rawAutoMerge as (typeof AUTO_MERGE_METHODS)[number];
	// DERIVED default, not a static one. Unset means "no-auto-merge" where there
	// is an auto-merge to withhold, and "false" where there is not — so leaving
	// it unset costs nothing on a repo that does not auto-merge, rather than
	// spawning the config-dependency hook replay to compute a verdict that could
	// not change any outcome. An explicit value always wins, including an
	// explicit "false" on a repo that does auto-merge.
	const rawCheckPeers = yield* ActionInput.string("check-peers").pipe(Config.withDefault(""));
	const checkPeers = rawCheckPeers === "" ? (rawAutoMerge === "" ? "false" : "no-auto-merge") : rawCheckPeers;
	if (!(CHECK_PEERS_MODES as ReadonlyArray<string>).includes(checkPeers)) {
		yield* Effect.fail(
			new InvalidInputError({
				field: "check-peers",
				reason: 'Expected "false", "warn" or "no-auto-merge"',
				value: rawCheckPeers,
			}),
		);
	}
	// A gate that cannot fire. WARN rather than fail: `auto-merge` is legitimately
	// dynamic in a workflow expression, so a run where it resolves to "" is not a
	// misconfiguration -- failing here would break a valid workflow.
	if (checkPeers === "no-auto-merge" && rawAutoMerge === "") {
		yield* Effect.logWarning(
			'check-peers: "no-auto-merge" has no effect because auto-merge is disabled; ' +
				"peer issues will be reported but nothing is gated",
		);
	}
	const dryRun = yield* ActionInput.boolean("dry-run").pipe(Config.withDefault(false));
	const timeout = yield* ActionInput.integer("timeout").pipe(Config.withDefault(180));
	const rawRuntimeNode = yield* ActionInput.string("upgrade-runtime-node").pipe(Config.withDefault("false"));
	const rawRuntimeDeno = yield* ActionInput.string("upgrade-runtime-deno").pipe(Config.withDefault("false"));
	const rawRuntimeBun = yield* ActionInput.string("upgrade-runtime-bun").pipe(Config.withDefault("false"));
	const runtimeData = yield* ActionInput.string("runtime-data").pipe(Config.withDefault("offline"));
	// Fails rather than falling back: silently resolving runtime versions from the
	// bundled snapshot when the workflow asked for live data is the same class of
	// quiet wrong answer as an input that never arrived.
	if (runtimeData !== "offline" && runtimeData !== "live") {
		yield* Effect.fail(
			new InvalidInputError({
				field: "runtime-data",
				reason: 'Expected "offline" or "live"',
				value: runtimeData,
			}),
		);
	}
	const runtimeLive = runtimeData === "live";

	// Validate upgrade-package-manager and each runtime input: must be an allowed keyword
	// or a parseable semver range.
	for (const [inputName, value, keywords] of [
		["upgrade-runtime-node", rawRuntimeNode, ["auto", "false"]],
		["upgrade-runtime-deno", rawRuntimeDeno, ["auto", "false"]],
		["upgrade-runtime-bun", rawRuntimeBun, ["auto", "false"]],
		["upgrade-package-manager", upgradePackageManager, ["true", "false", "auto"]],
	] as const) {
		if (!(keywords as ReadonlyArray<string>).includes(value)) {
			yield* Range.parse(value).pipe(
				Effect.mapError(
					(e) =>
						new InvalidInputError({
							field: inputName,
							reason: `Invalid semver range: ${String(e)}`,
							value,
						}),
				),
			);
		}
	}

	const anyRuntime = rawRuntimeNode !== "false" || rawRuntimeDeno !== "false" || rawRuntimeBun !== "false";
	if (anyRuntime) {
		yield* Effect.logInfo(`Runtime upgrades enabled (data source: ${runtimeData})`);
	}

	// Cross-validate: at least one update type must be active
	if (
		configDependencies.length === 0 &&
		dependencies.length === 0 &&
		upgradePackageManager === "false" &&
		!anyRuntime
	) {
		yield* Effect.fail(
			new InvalidInputError({
				field: "config-dependencies",
				reason: "At least one update type must be active",
				value: undefined,
			}),
		);
	}

	// Reject globs in the peer inputs BEFORE the overlap check.
	//
	// `peer-lock` and `peer-minor` entries are matched as literal package names
	// (`strategyMap` in `syncPeers` is keyed by exact name), while
	// `dependencies` entries ARE globs. A `@scope/*` typed into `peer-lock`
	// therefore matches nothing, silently: the overlap check compares raw
	// strings so it never fires, the "does not match any dependencies pattern"
	// warning below DOES fire but reads as a configuration nit, and the run
	// completes having synced no peer ranges at all. Rejecting is the only
	// signal proportional to "this input did nothing".
	// Validated per input, not over a merged list. Merging them and reporting a
	// hardcoded field name is the version this replaces: a glob in `peer-minor`
	// alone was reported against `peer-lock`, sending the reader to an input that
	// was fine. An error that names the wrong field is worse than a vague one,
	// because it is specific and confidently wrong.
	for (const [field, entries] of [
		["peer-lock", peerLock],
		["peer-minor", peerMinor],
	] as const) {
		const globbed = entries.filter((pkg) => /[*?[\]]/.test(pkg));
		if (globbed.length > 0) {
			yield* Effect.fail(
				new InvalidInputError({
					field,
					reason:
						`Glob patterns are not supported in ${field} (entries match exact package names): ${globbed.join(", ")}. ` +
						"Use `dependencies` for glob matching and list each peer dependency by name.",
					value: undefined,
				}),
			);
		}
	}

	// Validate peer-lock and peer-minor don't overlap
	const peerOverlap = peerLock.filter((p) => peerMinor.includes(p));
	if (peerOverlap.length > 0) {
		yield* Effect.fail(
			new InvalidInputError({
				field: "peer-lock",
				reason: `Packages appear in both peer-lock and peer-minor: ${peerOverlap.join(", ")}`,
				value: undefined,
			}),
		);
	}

	// Warn if peer entries don't match any dependencies pattern
	for (const pkg of [...peerLock, ...peerMinor]) {
		const hasMatch = dependencies.some((p) => matchesPattern(pkg, p));
		if (!hasMatch) {
			yield* Effect.logWarning(`peer-lock/peer-minor entry "${pkg}" does not match any dependencies pattern`);
		}
	}

	return {
		inputs: {
			branch,
			sourceBranch,
			targetBranch,
			"config-dependencies": configDependencies,
			dependencies,
			"peer-lock": peerLock,
			"peer-minor": peerMinor,
			"upgrade-package-manager": upgradePackageManager,
			changesets,
			"auto-merge": autoMerge,
			"check-peers": checkPeers as CheckPeersMode,
			run,
			runtime: { node: rawRuntimeNode, deno: rawRuntimeDeno, bun: rawRuntimeBun },
			runtimeData,
		} satisfies InnerProgramInputs,
		dryRun,
		timeout,
		runtimeLive,
	};
});
