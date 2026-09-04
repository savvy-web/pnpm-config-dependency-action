/**
 * Orchestration tests for `innerProgram`.
 *
 * `innerProgram` is where every package-manager dispatch decision lives: which
 * config-dependency service a repo routes to, whether the install runs, whether
 * the workspace-format step applies, and what a skipped step says about itself.
 * None of that is reachable from the service-level suites, so this file drives
 * `innerProgram` directly against a fake app layer and asserts on the log stream
 * it produces — the log IS the decision record, so asserting on it is asserting
 * on the decisions.
 *
 * What is real here and what is faked:
 * - **Real:** the upstream `WorkspaceRoot` / `PackageManagerDetector` layers,
 *   resolving against a temp-dir fixture — so "this is a bun repo" is a fact
 *   detection derived from files on disk, not a mock's say-so. The library's
 *   in-memory `ActionOutputs` / `CheckRun` test layers. `formatWorkspaceYaml`,
 *   `captureLockfileState` and `runInstall` run for real against the fixture.
 *   The package-manager tests use the real `PackageManagerUpgrade.layer` over an
 *   in-memory npm registry, so the "nothing satisfies this range" path is
 *   genuinely resolved rather than asserted into existence.
 * - **Faked:** the domain services whose own behavior is covered by their
 *   co-located suites (`ConfigDeps`, `CatalogConfigDeps`, `RegularDeps`,
 *   `RuntimeUpgrade`, `Changesets`, `BranchManager`, `Report`), plus
 *   `CommandRunner`, recorded so a dispatch can be proven by *which* service was
 *   called and which were not.
 *
 * @module program.inner.test
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { ScriptResult, SpawnRecord } from "@effected/commands";
import type { StatusEntry } from "@effected/git";
import { Git } from "@effected/git";
import { CheckRun } from "@effected/github";
import { ActionOutputs } from "@effected/github-actions";
import { PackageJsonFile } from "@effected/package-json";
import type { WorkspacePackage } from "@effected/workspaces";
import {
	NoPeerDependencyRules,
	PackageManagerDetector,
	WorkspaceCatalogs,
	WorkspaceDiscovery,
	WorkspaceRoot,
} from "@effected/workspaces";
import { Cause, Effect, Exit, Layer, Logger, Option, References } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidInputError } from "../../src/errors/errors.js";
import type { makeAppLayer } from "../../src/layers/app.js";
import { innerProgram } from "../../src/program.js";
import type { DependencyUpdateResult } from "../../src/schema/domain.js";
import type { InnerProgramInputs } from "../../src/schema/inputs.js";
import { BranchManager } from "../../src/services/branch.js";
import { CatalogConfigDeps } from "../../src/services/catalog-config-deps.js";
import { Changesets } from "../../src/services/changesets.js";
import { ConfigDeps } from "../../src/services/config-deps.js";
import { PackageManagerUpgrade } from "../../src/services/package-manager-upgrade.js";
import { RegularDeps } from "../../src/services/regular-deps.js";
import { Report } from "../../src/services/report.js";
import { RuntimeUpgrade } from "../../src/services/runtime-upgrade.js";
import { seededRegistry } from "../utils/fixtures.js";
import { fromMap } from "../utils/spawner.js";

// ══════════════════════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════════════════════

/** The package managers a fixture can be built for, plus the unsupported one. */
type FixturePm = "pnpm" | "bun" | "npm" | "yarn";

let root: string;
let cwd: string;
/** `root` as `process.cwd()` reports it — on macOS tmpdir is a symlink (/var -> /private/var). */
let realRoot: string;

/**
 * Write a workspace fixture that the REAL upstream detector will classify as
 * `pm`. Detection reads these files, so the routing under test is driven by the
 * same evidence a real repo would present.
 */
const writeFixture = (pm: FixturePm): void => {
	const pkg: Record<string, unknown> = { name: "root", private: true };

	switch (pm) {
		case "pnpm":
			writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
			break;
		case "bun":
			// @effected/workspaces' detector requires a bun lockfile conjoined with
			// the manifest naming bun (the same conjunction it applies to yarn),
			// so a valid bun.lock is written alongside devEngines.packageManager.
			pkg.workspaces = ["."];
			pkg.devEngines = { packageManager: { name: "bun", version: "1.3.14" } };
			writeFileSync(
				join(root, "bun.lock"),
				`${JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "root" } }, packages: {} }, null, "\t")}\n`,
			);
			break;
		case "npm":
			pkg.workspaces = ["packages/*"];
			break;
		case "yarn":
			pkg.workspaces = ["."];
			pkg.packageManager = "yarn@4.5.0";
			writeFileSync(join(root, "yarn.lock"), "");
			break;
	}

	writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
};

/** A deliberately unsorted pnpm-workspace.yaml, so formatting it is observable. */
const UNSORTED_WORKSPACE_YAML = 'packages:\n  - "zeta"\n  - "alpha"\nonlyBuiltDependencies:\n  - "zzz"\n  - "aaa"\n';

// ══════════════════════════════════════════════════════════════════════════════
// Log capture
// ══════════════════════════════════════════════════════════════════════════════

interface LogLine {
	readonly level: string;
	readonly message: string;
}

let logs: LogLine[];

const captureLogger = Layer.succeed(
	References.CurrentLoggers,
	new Set([
		Logger.make(({ logLevel, message }) => {
			const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
			logs.push({ level: logLevel, message: text });
		}),
	]),
);

/** Every captured message, regardless of level. */
const messages = (): string[] => logs.map((l) => l.message);

/** Only the WARN-level messages — the acceptance signals. */
const warnings = (): string[] => logs.filter((l) => l.level === "Warn").map((l) => l.message);

/**
 * WARN-level messages about the package-manager upgrade specifically.
 *
 * A never-installed fixture legitimately warns about other things (no lockfile
 * to diff), so "the benign skips do not warn" is asserted against the
 * package-manager step's own output rather than against total silence.
 */
const packageManagerWarnings = (): string[] =>
	warnings().filter((m) => /satisfies|upgrade-package-manager|no upgrade/.test(m));

/** Find one message containing every fragment; fails the caller's expect if absent. */
const findLine = (level: string | null, ...fragments: string[]): LogLine | undefined =>
	logs.find((l) => (level === null || l.level === level) && fragments.every((f) => l.message.includes(f)));

// ══════════════════════════════════════════════════════════════════════════════
// Service fakes
// ══════════════════════════════════════════════════════════════════════════════

/** Records the calls each faked service received, so a dispatch can be proven. */
interface Spies {
	readonly configDeps: ReturnType<typeof vi.fn>;
	readonly catalogConfigDeps: ReturnType<typeof vi.fn>;
	readonly regularDeps: ReturnType<typeof vi.fn>;
	readonly runtimeUpgrade: ReturnType<typeof vi.fn>;
	readonly changesetsCreate: ReturnType<typeof vi.fn>;
	readonly commitChanges: ReturnType<typeof vi.fn>;
	readonly createOrUpdatePR: ReturnType<typeof vi.fn>;
	/** Every spawned command as a flat line, e.g. `pnpm install --frozen-lockfile=false`. */
	readonly execLines: ReadonlyArray<SpawnRecord>;
}

interface HarnessOptions {
	/** Updates `ConfigDeps` / `CatalogConfigDeps` report (drives the install gate). */
	readonly configUpdates?: ReadonlyArray<DependencyUpdateResult>;
	/** Updates `RegularDeps` reports (drives the install gate). */
	readonly regularUpdates?: ReadonlyArray<DependencyUpdateResult>;
	/**
	 * Paths `git status` reports as changed — a non-empty list means "the tree
	 * changed". Entries are typed now that the status read goes through
	 * `@effected/git` rather than a porcelain parser this repo owned.
	 */
	readonly gitStatus?: ReadonlyArray<string>;
	/** Registry contents for the real `PackageManagerUpgrade.layer`. */
	readonly registry?: Record<string, { version: string; versions?: ReadonlyArray<string> }>;
	/** Replace the real package-manager upgrade with a fake returning this outcome. */
	readonly packageManagerUpgrade?: Effect.Success<typeof PackageManagerUpgrade>["upgrade"];
	/** Extra scripted command results, keyed by full command line. */
	readonly commands?: ReadonlyMap<string, ScriptResult>;
}

const update = (dependency: string, from: string, to: string): DependencyUpdateResult => ({
	dependency,
	from,
	to,
	type: "devDependency",
	package: "root",
});

/**
 * Build the fake app layer plus the spies that prove which path ran.
 *
 * The real `WorkspaceRoot`/`PackageManagerDetector` sit alongside the fakes, so
 * package-manager detection is genuine while everything downstream is observable.
 */
const makeHarness = (options: HarnessOptions = {}) => {
	const outputs = new Map<string, string>();
	/** Check runs created, and the verdict each was concluded with. */
	const checkRunState = {
		runs: [] as Array<{
			name: string;
			status: string;
			conclusion: string | undefined;
			/** The output an explicit `conclude` supplied, if any. */
			output: { title?: string; summary?: string } | undefined;
		}>,
	};

	// Every command whose OUTPUT the program reads now goes through `Git`;
	// everything left on the spawner is asserted by which command line ran.
	const spawner = fromMap(new Map([...(options.commands ?? new Map())]));

	/** Config keys the run wrote, so the `core.fileMode` pin is observable. */
	const gitConfig = new Map<string, string>();
	/** The directories those writes targeted — the pin must land at the root. */
	const gitConfigRoots: Array<string> = [];
	const gitLayer = Git.layerTest({
		status: () =>
			Effect.succeed((options.gitStatus ?? []).map((path) => ({ x: " ", y: "M", path }) as unknown as StatusEntry)),
		configSet: (cwd: string, key: string, value: string) =>
			Effect.sync(() => {
				gitConfig.set(key, value);
				gitConfigRoots.push(cwd);
			}),
	} as never);
	const execLines = spawner.spawns;

	const spies: Spies = {
		configDeps: vi.fn(() => Effect.succeed(options.configUpdates ?? [])),
		catalogConfigDeps: vi.fn(() => Effect.succeed({ updates: options.configUpdates ?? [], deltas: [] })),
		regularDeps: vi.fn(() => Effect.succeed(options.regularUpdates ?? [])),
		runtimeUpgrade: vi.fn(() => Effect.succeed([])),
		changesetsCreate: vi.fn(() => Effect.succeed([])),
		commitChanges: vi.fn(() => Effect.void),
		createOrUpdatePR: vi.fn(() =>
			Effect.succeed({ number: 1, url: "https://github.com/o/r/pull/1", created: true, nodeId: "PR_1" }),
		),
		execLines,
	};

	const discovery = Layer.succeed(WorkspaceDiscovery, {
		listPackages: vi.fn(() => Effect.succeed([] as ReadonlyArray<WorkspacePackage>)),
		getPackage: vi.fn(() => Effect.die("getPackage not used in innerProgram tests")),
		infoIn: vi.fn(() => Effect.die("infoIn not used in innerProgram tests")),
		listPackagesIn: vi.fn(() => Effect.die("listPackagesIn not used in innerProgram tests")),
		refreshIn: vi.fn(() => Effect.die("refreshIn not used in innerProgram tests")),
		importerMap: vi.fn(() => Effect.succeed(new Map())),
		info: vi.fn(() => Effect.die("info not used in innerProgram tests")),
		resolveFile: vi.fn(() => Effect.die("resolveFile not used in innerProgram tests")),
		resolveFiles: vi.fn(() => Effect.die("resolveFiles not used in innerProgram tests")),
		refresh: vi.fn(() => Effect.void),
	});

	// The real detector, over the temp-dir fixture.
	const detection = Layer.mergeAll(
		PackageManagerDetector.layer,
		WorkspaceRoot.layer.pipe(Layer.provide(NodeServices.layer)),
	).pipe(Layer.provide(NodeServices.layer));

	const npmRegistry = seededRegistry(options.registry ?? {});

	// The package-manager upgrade is REAL unless a test explicitly fakes the
	// outcome: the acceptance-signal guard must resolve the range against an
	// actual release list, not against a mock that was told the answer.
	// Real PackageJsonFile over the real platform: the upgrade services write
	// through it, and these suites run against actual temp-dir fixtures.
	const packageJsonFile = PackageJsonFile.layer.pipe(Layer.provide(NodeServices.layer));

	const packageManagerUpgrade = options.packageManagerUpgrade
		? Layer.succeed(PackageManagerUpgrade, { upgrade: options.packageManagerUpgrade })
		: PackageManagerUpgrade.layer.pipe(Layer.provide(Layer.merge(npmRegistry, packageJsonFile)));

	// Peer-suppression rules the peer-check step reads. Asserting
	// NoPeerDependencyRules ("I looked, there are none") rather than omitting,
	// so the report is VERIFIED and the gate's verdict is driven by the lockfile
	// rather than by an `unverified` short-circuit.
	const catalogs = WorkspaceCatalogs.layerTest({
		peerDependencyRules: () => Effect.succeed(NoPeerDependencyRules),
	});

	const layer = Layer.mergeAll(
		catalogs,
		ActionOutputs.layerTest({
			set: (name: string, value: string) =>
				Effect.suspend(() => {
					outputs.set(name, value);
					return Effect.void;
				}),
			summary: () => Effect.void,
		}),
		// withCheckRun concludes on EVERY exit path now, defaulting to
		// success/failure, and a verdict recorded via `conclude` wins.
		CheckRun.layerTest({
			withCheckRun: (name, _headSha, use) =>
				Effect.gen(function* () {
					const run = {
						name,
						status: "in_progress",
						conclusion: undefined as string | undefined,
						output: undefined as { title?: string; summary?: string } | undefined,
					};
					checkRunState.runs.push(run);
					const conclude = (conclusion: string, output?: { title?: string; summary?: string }) =>
						Effect.sync(() => {
							run.conclusion = conclusion;
							run.output = output;
							run.status = "completed";
						});
					return yield* use(1, conclude as never).pipe(
						Effect.onExit((exit) =>
							Effect.sync(() => {
								if (run.conclusion === undefined) {
									run.conclusion = exit._tag === "Success" ? "success" : "failure";
									run.status = "completed";
								}
							}),
						),
					);
				}) as never,
		}),
		spawner.layer,
		gitLayer,
		discovery,
		detection,
		packageManagerUpgrade,
		Layer.succeed(ConfigDeps, {
			updateConfigDeps: spies.configDeps as unknown as Effect.Success<typeof ConfigDeps>["updateConfigDeps"],
		}),
		Layer.succeed(CatalogConfigDeps, {
			update: spies.catalogConfigDeps as unknown as Effect.Success<typeof CatalogConfigDeps>["update"],
		}),
		Layer.succeed(RegularDeps, {
			updateRegularDeps: spies.regularDeps as unknown as Effect.Success<typeof RegularDeps>["updateRegularDeps"],
		}),
		Layer.succeed(RuntimeUpgrade, {
			upgrade: spies.runtimeUpgrade as unknown as Effect.Success<typeof RuntimeUpgrade>["upgrade"],
		}),
		Layer.succeed(Changesets, {
			create: spies.changesetsCreate as unknown as Effect.Success<typeof Changesets>["create"],
		}),
		Layer.succeed(BranchManager, {
			manage: () => Effect.succeed({ branch: "pnpm/config-deps", created: true, upToDate: false, baseRef: "main" }),
			validateBranches: () => Effect.void,
			commitChanges: spies.commitChanges as unknown as Effect.Success<typeof BranchManager>["commitChanges"],
			ensureBaseHistory: () => Effect.void,
		}),
		Layer.succeed(Report, {
			createOrUpdatePR: spies.createOrUpdatePR as unknown as Effect.Success<typeof Report>["createOrUpdatePR"],
			generatePRBody: () => "body",
			generateSummary: () => "summary",
			generateCommitMessage: () => "chore(deps): update dependencies",
		}),
	);

	return {
		spies,
		outputs,
		checkRunState,
		spawner,
		gitConfig,
		gitConfigRoots,
		layer: layer as unknown as ReturnType<typeof makeAppLayer>,
	};
};

const baseInputs = (overrides: Partial<InnerProgramInputs> = {}): InnerProgramInputs => ({
	// Default OFF, mirroring the input's own default: a composition test that
	// silently opted every case into the peer check would make the gate look
	// exercised everywhere and pin nothing.
	"check-peers": "false",
	branch: "pnpm/config-deps",
	sourceBranch: "main",
	targetBranch: "main",
	"config-dependencies": [],
	dependencies: [],
	"peer-lock": [],
	"peer-minor": [],
	"upgrade-package-manager": "false",
	changesets: false,
	"auto-merge": "",
	run: [],
	runtime: { node: "false", deno: "false", bun: "false" },
	runtimeData: "offline",
	...overrides,
});

/** Run innerProgram to an Exit, capturing logs. Never throws. */
const runInner = (
	harness: ReturnType<typeof makeHarness>,
	inputs: InnerProgramInputs,
	dryRun = false,
): Promise<Exit.Exit<void, unknown>> =>
	Effect.runPromiseExit(
		innerProgram(inputs, dryRun, "deadbeef", harness.layer).pipe(
			Effect.provide(captureLogger),
			Effect.provideService(References.MinimumLogLevel, "Info"),
		) as Effect.Effect<void, unknown, never>,
	);

beforeEach(() => {
	logs = [];
	root = mkdtempSync(join(tmpdir(), "inner-program-"));
	cwd = process.cwd();
	// Detection starts from process.cwd() and walks up to the workspace root;
	// everything downstream is anchored at that resolved root. Most tests run
	// with cwd === root, so the two coincide; the "workspace root threading"
	// suite deliberately chdirs into a subdirectory so they do not.
	process.chdir(root);
	realRoot = process.cwd();
});

afterEach(() => {
	process.chdir(cwd);
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Package-manager dispatch: config dependencies
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — config-dependency dispatch", () => {
	it("routes a pnpm repo to ConfigDeps and never to CatalogConfigDeps", async () => {
		writeFixture("pnpm");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ "config-dependencies": ["pnpm-plugin-silk"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.configDeps).toHaveBeenCalledWith(["pnpm-plugin-silk"], realRoot);
		expect(harness.spies.catalogConfigDeps).not.toHaveBeenCalled();
		expect(findLine("Info", "Step: config dependencies", "pnpm mode")).toBeDefined();
	});

	it("routes a bun repo to CatalogConfigDeps and never to ConfigDeps", async () => {
		writeFixture("bun");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ "config-dependencies": ["pnpm-plugin-silk"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.catalogConfigDeps).toHaveBeenCalledWith(["pnpm-plugin-silk"], realRoot);
		expect(harness.spies.configDeps).not.toHaveBeenCalled();
		expect(findLine("Info", "Step: config dependencies", "compat catalog mode")).toBeDefined();
	});

	it("routes an npm repo to neither service and warns that npm has no catalog: protocol", async () => {
		writeFixture("npm");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ "config-dependencies": ["pnpm-plugin-silk"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.configDeps).not.toHaveBeenCalled();
		expect(harness.spies.catalogConfigDeps).not.toHaveBeenCalled();
		expect(findLine("Warn", "npm does not implement the catalog: protocol")).toBeDefined();
		expect(findLine("Info", "Step: config dependencies — SKIPPED", "npm has no catalog: protocol")).toBeDefined();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. The acceptance signal: a range that satisfies nothing must WARN
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — package-manager upgrade acceptance signal", () => {
	/** bun's real release list — nothing here satisfies a pnpm-shaped "^11.0.0". */
	const bunRegistry = () => ({ bun: { version: "1.3.14", versions: ["1.3.12", "1.3.13", "1.3.14"] } });

	it("WARNS, naming the package manager and the range, when nothing satisfies it (pnpm range in a bun repo)", async () => {
		writeFixture("bun");
		const harness = makeHarness({ registry: bunRegistry() });

		const exit = await runInner(harness, baseInputs({ "upgrade-package-manager": "^11.0.0" }));

		expect(Exit.isSuccess(exit)).toBe(true);

		// The signal must be at WARN — not buried at info alongside routine skips.
		const warning = findLine("Warn", "no bun release satisfies", '"^11.0.0"');
		expect(warning).toBeDefined();
		expect(warning?.message).toContain("upgrade-package-manager range is a bun range");

		// And it must not have been reported ONLY at info.
		expect(warnings().some((m) => m.includes("^11.0.0"))).toBe(true);
	});

	it("does NOT warn when the upgrade is disabled", async () => {
		writeFixture("bun");
		const harness = makeHarness({ registry: bunRegistry() });

		const exit = await runInner(harness, baseInputs({ "upgrade-package-manager": "false", dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(findLine("Info", "Step: package manager — SKIPPED", "disabled")).toBeDefined();
		expect(packageManagerWarnings()).toEqual([]);
	});

	it("does NOT warn when the package manager is already at the latest satisfying version", async () => {
		writeFixture("bun");
		// devEngines pins bun 1.3.14 and 1.3.14 is the newest release: nothing to do.
		const harness = makeHarness({ registry: bunRegistry() });

		const exit = await runInner(harness, baseInputs({ "upgrade-package-manager": "auto" }));

		expect(Exit.isSuccess(exit)).toBe(true);
		// The benign twin of the case above: same step, same "no upgrade" outcome,
		// reported at INFO because nothing is misconfigured.
		expect(findLine("Info", "SKIPPED:", "bun 1.3.14 already satisfies")).toBeDefined();
		expect(packageManagerWarnings()).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. The workspace-format gate
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — workspace-format gate", () => {
	it("formats pnpm-workspace.yaml for a pnpm repo", async () => {
		writeFixture("pnpm");
		writeFileSync(join(root, "pnpm-workspace.yaml"), UNSORTED_WORKSPACE_YAML);
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(findLine("Info", "Step: workspace formatting — formatting pnpm-workspace.yaml")).toBeDefined();

		// Proof it actually ran, not just that it logged: the file is now sorted.
		const formatted = readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8");
		expect(formatted.indexOf("alpha")).toBeLessThan(formatted.indexOf("zeta"));
		expect(formatted.indexOf("aaa")).toBeLessThan(formatted.indexOf("zzz"));
	});

	it("SKIPS formatting for a bun repo, stating the reason", async () => {
		writeFixture("bun");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(
			findLine("Info", "Step: workspace formatting — SKIPPED", "not a pnpm workspace (detected bun)"),
		).toBeDefined();
	});

	it("SKIPS formatting for an npm repo, stating the reason", async () => {
		writeFixture("npm");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(
			findLine("Info", "Step: workspace formatting — SKIPPED", "not a pnpm workspace (detected npm)"),
		).toBeDefined();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. The install gate
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — install gate", () => {
	it("installs when there are updates, using the detected package manager's command", async () => {
		writeFixture("pnpm");
		const harness = makeHarness({ regularUpdates: [update("effect", "^3.0.0", "^3.1.0")] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.execLines.map((call) => [call.command, ...call.args].join(" "))).toContain(
			"pnpm clean --lockfile",
		);
		expect(harness.spies.execLines.map((call) => [call.command, ...call.args].join(" "))).toContain(
			"pnpm install --frozen-lockfile=false",
		);
		expect(findLine("Info", "Step: install — pnpm clean --lockfile")).toBeDefined();
	});

	it("installs with bun's command in a bun repo", async () => {
		writeFixture("bun");
		const harness = makeHarness({ regularUpdates: [update("effect", "^3.0.0", "^3.1.0")] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.execLines.map((call) => [call.command, ...call.args].join(" "))).toContain(
			"bun install --force",
		);
		expect(harness.spies.execLines).not.toContain("pnpm install --frozen-lockfile=false");
	});

	it("does NOT install when there is nothing to install, and says so", async () => {
		writeFixture("pnpm");
		const harness = makeHarness({ regularUpdates: [] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(
			harness.spies.execLines.some((call) => [call.command, ...call.args].join(" ").startsWith("pnpm install")),
		).toBe(false);
		expect(findLine("Info", "Step: install — SKIPPED", "nothing to install")).toBeDefined();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. No silent skips
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — no silent skips", () => {
	it("logs a SKIPPED line with a reason for every step that does not run", async () => {
		writeFixture("bun");
		// A tree with changes, so the run proceeds past the change gate and the
		// changeset / commit / PR steps are all reached and all skipped.
		const harness = makeHarness({ gitStatus: ["package.json"] });

		const exit = await runInner(harness, baseInputs({ "upgrade-package-manager": "false", changesets: false }), true);

		expect(Exit.isSuccess(exit)).toBe(true);

		const skipped = messages().filter((m) => m.includes("SKIPPED"));
		// Every skip names its reason — none is a bare "SKIPPED".
		for (const line of skipped) {
			expect(line).toMatch(/SKIPPED:\s*\S+/);
		}

		expect(findLine(null, "Step: package manager — SKIPPED", "disabled")).toBeDefined();
		expect(findLine(null, "Step: config dependencies — SKIPPED", "no config-dependencies configured")).toBeDefined();
		expect(findLine(null, "Step: regular dependencies — SKIPPED", "no dependencies patterns configured")).toBeDefined();
		expect(findLine(null, "Step: peer sync — SKIPPED", "no peer-lock or peer-minor patterns")).toBeDefined();
		expect(findLine(null, "Step: install — SKIPPED", "nothing to install")).toBeDefined();
		expect(findLine(null, "Step: workspace formatting — SKIPPED", "not a pnpm workspace")).toBeDefined();
		expect(findLine(null, "Step: custom commands — SKIPPED", "no run commands configured")).toBeDefined();
		expect(findLine(null, "Step: changesets — SKIPPED", "disabled (changesets: false)")).toBeDefined();
		expect(findLine(null, "Step: commit — SKIPPED", "dry run")).toBeDefined();
		expect(findLine(null, "Step: pull request — SKIPPED", "dry run")).toBeDefined();
	});

	it("skips the changeset step with a reason when the repo has no .changeset/ directory", async () => {
		writeFixture("pnpm");
		const harness = makeHarness({ gitStatus: ["package.json"] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"], changesets: true }), true);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.changesetsCreate).not.toHaveBeenCalled();
		expect(findLine(null, "Step: changesets — SKIPPED", "no .changeset/ directory")).toBeDefined();
	});

	it("runs the changeset step against the target branch when .changeset/ exists", async () => {
		writeFixture("pnpm");
		mkdirSync(join(root, ".changeset"));
		writeFileSync(join(root, ".changeset", "config.json"), "{}\n");
		const harness = makeHarness({ gitStatus: ["package.json"] });

		const exit = await runInner(
			harness,
			baseInputs({ dependencies: ["effect"], changesets: true, targetBranch: "main" }),
			true,
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		// The diff baseline is the resolved target-branch, not the source branch.
		expect(harness.spies.changesetsCreate).toHaveBeenCalledWith(realRoot, "main");
	});

	it("re-encodes `result` with the detected context on the no-changes exit", async () => {
		// Regression: both early-return paths set the two scalar outputs and left
		// `result` at the pre-run BASELINE, which carries `packageManager: null`
		// and `workspaceRoot: ""`. Detection has already succeeded by then, so the
		// document published to consumers was a false statement about the run —
		// and silently so: it parses, every field is present, and nothing in the
		// log distinguishes it from a run that genuinely never detected anything.
		//
		// The no-changes exit is the one a consumer is most likely to inspect
		// programmatically, which is why it is pinned rather than assumed.
		writeFixture("pnpm");
		const harness = makeHarness({ gitStatus: [] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }), true);

		expect(Exit.isSuccess(exit)).toBe(true);
		const document = JSON.parse(harness.outputs.get("result") ?? "{}");
		expect(document.hasChanges).toBe(false);
		expect(document.packageManager).toBe("pnpm");
		expect(document.workspaceRoot).toBe(realRoot);
	});

	it("reports the completed work in `result` when a custom command fails", async () => {
		// The failure exit returns through its own branch, so the other two exits
		// being correct says nothing about it.
		//
		// Two separate defects have lived here. First the document carried the
		// pre-run BASELINE, so `packageManager` was null after detection had
		// succeeded. That was fixed — and the fix left the document's *contents*
		// empty, so a run that bumped a dependency and then failed `pnpm test`
		// reported an empty update set for work that had actually happened and was
		// still sitting in the working tree. Fixing half a document is how it
		// looked correct.
		//
		// The update is what discriminates: the harness makes `RegularDeps` return
		// one, so an exit that drops it produces `updates: []` rather than a
		// missing field, which parses and reads as "nothing happened".
		writeFixture("pnpm");
		const harness = makeHarness({
			regularUpdates: [update("effect", "^3.0.0", "^3.1.0")],
			gitStatus: ["package.json"],
			commands: new Map([["sh -c exit 1", { exit: 1, stdout: "", stderr: "boom" }]]),
		});

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"], run: ["exit 1"] }), true);

		expect(Exit.isFailure(exit)).toBe(true);
		const document = JSON.parse(harness.outputs.get("result") ?? "{}");
		expect(document.packageManager).toBe("pnpm");
		expect(document.workspaceRoot).toBe(realRoot);
		// `hasChanges` is about the commit/PR, which did not happen.
		expect(document.hasChanges).toBe(false);
		// The updates did happen, and the document must say so.
		expect(document.updates).toContainEqual(
			expect.objectContaining({ dependency: "effect", from: "^3.0.0", to: "^3.1.0" }),
		);
		// The scalar cannot contradict the document — they are the same fact.
		expect(harness.outputs.get("updates-count")).toBe("1");
	});

	it("pins core.fileMode=false on the checkout before any status read", async () => {
		// The run's change verdict and the commit's file list are two separate
		// status reads. Neither passes a per-command flag any more, so the ONLY
		// thing keeping an executable-bit-only flip from producing an empty commit
		// and a spurious PR is this one config write happening — and happening at
		// the DETECTED workspace root, not wherever the process was invoked.
		writeFixture("pnpm");
		const harness = makeHarness({ gitStatus: ["package.json"] });

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }), true);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.gitConfig.get("core.fileMode")).toBe("false");
		expect(harness.gitConfigRoots).toContain(realRoot);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. The workspace root — not the cwd — is what reaches the services
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — workspace root threading", () => {
	/**
	 * Every file-I/O helper takes an optional `workspaceRoot` that defaults to
	 * `process.cwd()`. The action can be invoked from a subdirectory of the
	 * workspace (a monorepo package, a `working-directory:` step), in which case
	 * the cwd is NOT the workspace root — so the detected root has to be threaded
	 * explicitly. Run from a subdirectory and assert the root, not the cwd, is
	 * what every service receives and what the real helpers read/write.
	 */
	it("passes the detected workspace root (not process.cwd()) to every service and helper", async () => {
		writeFixture("pnpm");
		writeFileSync(join(root, "pnpm-workspace.yaml"), UNSORTED_WORKSPACE_YAML);

		// Run from a package subdirectory: cwd !== workspace root.
		const subdir = join(root, "packages", "app");
		mkdirSync(subdir, { recursive: true });
		process.chdir(subdir);
		const realSubdir = process.cwd();
		expect(realSubdir).not.toBe(realRoot);

		const packageManagerUpgrade = vi.fn(() =>
			Effect.succeed({
				applied: false as const,
				pm: "pnpm" as const,
				reference: null,
				referenceSource: null,
				targetRange: null,
				kind: "no-reference" as const,
				reason: "no reference version found",
			}),
		);

		const harness = makeHarness({
			regularUpdates: [update("effect", "^3.0.0", "^3.1.0")],
			gitStatus: ["package.json"],
			packageManagerUpgrade: packageManagerUpgrade as unknown as Effect.Success<
				typeof PackageManagerUpgrade
			>["upgrade"],
		});

		const exit = await runInner(
			harness,
			baseInputs({
				"config-dependencies": ["pnpm-plugin-silk"],
				dependencies: ["effect"],
				"upgrade-package-manager": "auto",
				changesets: true,
			}),
			true,
		);

		expect(Exit.isSuccess(exit)).toBe(true);

		// The faked services each received the root, not the cwd.
		expect(packageManagerUpgrade).toHaveBeenCalledWith("auto", "pnpm", realRoot);
		expect(harness.spies.configDeps).toHaveBeenCalledWith(["pnpm-plugin-silk"], realRoot);
		expect(harness.spies.regularDeps).toHaveBeenCalledWith(["effect"], realRoot, undefined);
		expect(harness.spies.runtimeUpgrade).toHaveBeenCalledWith({ node: "false", deno: "false", bun: "false" }, realRoot);

		// And the REAL helpers did too: formatWorkspaceYaml sorted the root's
		// pnpm-workspace.yaml (there is none in the subdirectory to sort), and the
		// install ran anchored at the root rather than at the cwd.
		const formatted = readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8");
		expect(formatted.indexOf("alpha")).toBeLessThan(formatted.indexOf("zeta"));
		const install = harness.spies.execLines.find(
			(call) => [call.command, ...call.args].join(" ") === "pnpm install --frozen-lockfile=false",
		);
		expect(install).toBeDefined();
		expect(install?.cwd).toBe(realRoot);

		// And so did the `result` document. This is the SUCCESS path — the third
		// exit, alongside the two early returns pinned above — and it had no
		// assertion at all until a mis-aimed mutation replaced its `detected` with
		// `{ pm: "npm", root: "" }` and the whole suite stayed green. A document
		// that can be false and is never read is the same defect the early-return
		// fix addressed, one path over.
		//
		// The subdirectory setup is what makes `workspaceRoot` discriminating here:
		// a cwd-defaulted document would report `realSubdir` and still parse.
		const document = JSON.parse(harness.outputs.get("result") ?? "{}");
		expect(document.hasChanges).toBe(true);
		expect(document.packageManager).toBe("pnpm");
		expect(document.workspaceRoot).toBe(realRoot);
		expect(document.updates).toContainEqual(
			expect.objectContaining({ dependency: "effect", from: "^3.0.0", to: "^3.1.0" }),
		);
	});

	it("passes the detected workspace root to the changeset step as the diff cwd", async () => {
		writeFixture("pnpm");
		mkdirSync(join(root, ".changeset"), { recursive: true });
		writeFileSync(join(root, ".changeset", "config.json"), "{}\n");

		// .changeset/ lives at the root; from the subdirectory it is invisible to a
		// cwd-relative lookup, so a cwd-defaulted hasChangesets would skip the step.
		const subdir = join(root, "packages", "app");
		mkdirSync(subdir, { recursive: true });
		process.chdir(subdir);

		const harness = makeHarness({ gitStatus: ["package.json"] });

		const exit = await runInner(
			harness,
			baseInputs({ dependencies: ["effect"], changesets: true, targetBranch: "main" }),
			true,
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(harness.spies.changesetsCreate).toHaveBeenCalledWith(realRoot, "main");
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Detection failure is visible
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — unsupported workspace", () => {
	it("fails with InvalidInputError from INSIDE the check run, so the failure is visible in the UI", async () => {
		writeFixture("yarn");
		const harness = makeHarness();

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"] }));

		expect(Exit.isFailure(exit)).toBe(true);
		const failure = Exit.isFailure(exit) ? Option.getOrNull(Cause.findErrorOption(exit.cause)) : null;
		expect(failure).toBeInstanceOf(InvalidInputError);
		expect((failure as InvalidInputError).reason).toContain("does not support");

		// The check run was created BEFORE detection ran — detection lives inside
		// withCheckRun precisely so this failure is reported in the GitHub UI rather
		// than vanishing as an early exit — and it was completed, not left dangling.
		expect(harness.checkRunState.runs).toHaveLength(1);
		expect(harness.checkRunState.runs[0]?.name).toBe("Dependency Updates");
		expect(harness.checkRunState.runs[0]?.status).toBe("completed");
		expect(harness.checkRunState.runs[0]?.conclusion).toBe("failure");

		// It failed at detection: nothing destructive or downstream ran.
		expect(harness.spies.regularDeps).not.toHaveBeenCalled();
		expect(harness.spies.commitChanges).not.toHaveBeenCalled();
		expect(harness.spies.execLines).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// Custom commands
// ══════════════════════════════════════════════════════════════════════════════

describe("innerProgram — custom commands", () => {
	it("concludes the check run as failure and exits early when a `run` command fails", async () => {
		// Regression guard for the withCheckRun migration.
		writeFixture("pnpm");
		const harness = makeHarness({
			configUpdates: [update("effect", "3.0.0", "3.1.0")],
			gitStatus: ["package.json"],
			commands: new Map([["sh -c pnpm lint", { exit: 1, stdout: "", stderr: "lint exploded" }]]),
		});

		const exit = await runInner(harness, baseInputs({ dependencies: ["effect"], run: ["pnpm lint"] }));

		// The run FAILS (it does not exit early), so the bracket would conclude
		// "failure" on its own. What the explicit `conclude` adds is the OUTPUT —
		// which is what names the failing command in the GitHub UI, and what a
		// mutation dropping the call would silently lose.
		expect(Exit.isFailure(exit)).toBe(true);
		expect(harness.checkRunState.runs[0]?.conclusion).toBe("failure");
		expect(harness.checkRunState.runs[0]?.output?.title).toBe("Custom Commands Failed");
		expect(harness.checkRunState.runs[0]?.output?.summary).toContain("pnpm lint");
		// No commit and no PR once a command failed.
		expect(harness.spies.commitChanges).not.toHaveBeenCalled();
		expect(harness.spies.createOrUpdatePR).not.toHaveBeenCalled();
	});
});

describe("check-peers gate", () => {
	// The CONTROL. Without it, "auto-merge was withheld" is indistinguishable
	// from "auto-merge is never passed through at all", and the gate test below
	// would pass against a build that simply dropped the input on the floor.
	it("passes auto-merge through untouched when the check is disabled", async () => {
		writeFixture("pnpm");
		const harness = makeHarness({ configUpdates: [update("effect", "4.0.0", "4.1.0")], gitStatus: ["package.json"] });
		await runInner(harness, baseInputs({ "check-peers": "false", "auto-merge": "squash" }));

		expect(harness.spies.createOrUpdatePR).toHaveBeenCalled();
		expect(harness.spies.createOrUpdatePR.mock.calls[0]?.[4]).toBe("squash");
	});

	// The gate, driven by a REAL pnpm lockfile carrying a genuine unmet peer
	// (react-dom@18.3.1 against react@17.0.2, generated by pnpm 11.22.0).
	// Without a lockfile the step short-circuits on "nothing examined", which
	// withholds for the RIGHT boolean and the WRONG reason -- so a test without
	// one would pass against a gate that never reads a report at all.
	it("withholds auto-merge on a real unsatisfied peer, and reports it", async () => {
		writeFixture("pnpm");
		writeFileSync(
			join(root, "pnpm-lock.yaml"),
			readFileSync(new URL("./steps/fixtures/pnpm-lock.unmet-peer.yaml", import.meta.url), "utf8"),
		);
		const harness = makeHarness({ configUpdates: [update("effect", "4.0.0", "4.1.0")], gitStatus: ["package.json"] });
		await runInner(harness, baseInputs({ "check-peers": "no-auto-merge", "auto-merge": "squash" }));

		expect(harness.spies.createOrUpdatePR).toHaveBeenCalled();
		// auto-merge withheld...
		expect(harness.spies.createOrUpdatePR.mock.calls[0]?.[4]).toBeUndefined();
		// ...and the issues actually REACH the PR body. Without this the thread
		// from step -> commit-and-pr -> report is unpinned, and deleting it
		// leaves every gate test green while the PR silently loses its section.
		const peerArg = harness.spies.createOrUpdatePR.mock.calls[0]?.[6] as ReadonlyArray<{ dependency: string }>;
		expect(peerArg.map((i) => i.dependency)).toContain("react");
	});
});
