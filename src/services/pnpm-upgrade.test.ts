import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner } from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { formatPnpmVersion, parsePnpmVersion } from "../utils/pnpm.js";
import { resolveLatestInRange } from "../utils/semver.js";
import { PnpmUpgrade, PnpmUpgradeLive } from "./pnpm-upgrade.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeTempDir = () => mkdtempSync(join(tmpdir(), "upgrade-test-"));

const writePackageJson = (dir: string, content: Record<string, unknown>) => {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(content, null, "\t")}\n`, "utf-8");
};

const readPackageJson = (dir: string) => {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
};

type CommandRunnerShape = Context.Tag.Service<typeof CommandRunner>;

const versions = JSON.stringify(["10.27.0", "10.28.0", "10.28.2", "10.29.0", "10.29.1", "11.0.0"]);

const makeExecCapture =
	(handler: (command: string, args?: ReadonlyArray<string>) => string) =>
	(command: string, args?: ReadonlyArray<string>) =>
		Effect.succeed({ exitCode: 0, stdout: handler(command, args), stderr: "" });

const defaultExecCapture = makeExecCapture(() => "ok");

const makeRunner = (
	execCaptureOverride?: (
		command: string,
		args?: ReadonlyArray<string>,
	) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, never>,
): CommandRunnerShape => ({
	exec: (_cmd, _args) => Effect.succeed(0),
	execCapture: execCaptureOverride ?? defaultExecCapture,
	execJson: (_cmd, _args, _schema) => Effect.die("not implemented"),
	execLines: (_cmd, _args) => Effect.succeed([]),
});

const runWithService = <A, E>(
	fn: (service: Context.Tag.Service<typeof PnpmUpgrade>) => Effect.Effect<A, E>,
	execCaptureOverride?: (
		command: string,
		args?: ReadonlyArray<string>,
	) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, never>,
) => {
	const commandRunnerLayer = Layer.succeed(CommandRunner, makeRunner(execCaptureOverride));
	const layer = PnpmUpgradeLive.pipe(Layer.provide(commandRunnerLayer));
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* PnpmUpgrade;
			return yield* fn(service);
		}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

const runWithServiceEither = <A, E>(
	fn: (service: Context.Tag.Service<typeof PnpmUpgrade>) => Effect.Effect<A, E>,
	execCaptureOverride?: (
		command: string,
		args?: ReadonlyArray<string>,
	) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, never>,
) => {
	const commandRunnerLayer = Layer.succeed(CommandRunner, makeRunner(execCaptureOverride));
	const layer = PnpmUpgradeLive.pipe(Layer.provide(commandRunnerLayer));
	return Effect.runPromise(
		Effect.either(
			Effect.gen(function* () {
				const service = yield* PnpmUpgrade;
				return yield* fn(service);
			}),
		).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

// ══════════════════════════════════════════════════════════════════════════════
// parsePnpmVersion
// ══════════════════════════════════════════════════════════════════════════════

describe("parsePnpmVersion", () => {
	describe("with pnpm@ prefix (packageManager field)", () => {
		it("parses exact version", () => {
			const result = parsePnpmVersion("pnpm@10.28.2", true);
			expect(result).toEqual({ version: "10.28.2", hasCaret: false, hasSha: false });
		});

		it("parses version with sha suffix", () => {
			const result = parsePnpmVersion("pnpm@10.28.2+sha512.abc123", true);
			expect(result).toEqual({ version: "10.28.2", hasCaret: false, hasSha: true });
		});

		it("parses caret version", () => {
			const result = parsePnpmVersion("pnpm@^10.28.2", true);
			expect(result).toEqual({ version: "10.28.2", hasCaret: true, hasSha: false });
		});

		it("parses caret version with sha", () => {
			const result = parsePnpmVersion("pnpm@^10.28.2+sha512.abc123", true);
			expect(result).toEqual({ version: "10.28.2", hasCaret: true, hasSha: true });
		});

		it("returns null for non-pnpm packageManager", () => {
			const result = parsePnpmVersion("yarn@4.0.0", true);
			expect(result).toBeNull();
		});

		it("returns null for empty string", () => {
			const result = parsePnpmVersion("", true);
			expect(result).toBeNull();
		});

		it("returns null for invalid semver", () => {
			const result = parsePnpmVersion("pnpm@notaversion", true);
			expect(result).toBeNull();
		});
	});

	describe("without prefix (devEngines version field)", () => {
		it("parses exact version", () => {
			const result = parsePnpmVersion("10.28.2");
			expect(result).toEqual({ version: "10.28.2", hasCaret: false, hasSha: false });
		});

		it("parses caret version", () => {
			const result = parsePnpmVersion("^10.28.2");
			expect(result).toEqual({ version: "10.28.2", hasCaret: true, hasSha: false });
		});

		it("returns null for empty string", () => {
			const result = parsePnpmVersion("");
			expect(result).toBeNull();
		});

		it("returns null for invalid semver", () => {
			const result = parsePnpmVersion("invalid");
			expect(result).toBeNull();
		});
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// formatPnpmVersion
// ══════════════════════════════════════════════════════════════════════════════

describe("formatPnpmVersion", () => {
	it("formats version with caret", () => {
		expect(formatPnpmVersion("10.29.0", true)).toBe("^10.29.0");
	});

	it("formats exact version without caret", () => {
		expect(formatPnpmVersion("10.29.0", false)).toBe("10.29.0");
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveLatestInRange
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveLatestInRange", () => {
	const versionList = ["10.27.0", "10.28.0", "10.28.2", "10.29.0", "10.29.1", "11.0.0", "11.0.0-beta.1"];

	it("finds the highest version satisfying ^current", async () => {
		const result = await Effect.runPromise(resolveLatestInRange(versionList, "10.28.2"));
		expect(result).toBe("10.29.1");
	});

	it("returns current if it is the highest in range", async () => {
		const result = await Effect.runPromise(resolveLatestInRange(versionList, "10.29.1"));
		expect(result).toBe("10.29.1");
	});

	it("skips pre-release versions", async () => {
		const result = await Effect.runPromise(resolveLatestInRange(versionList, "11.0.0"));
		// Only 11.0.0 is stable in the 11.x range
		expect(result).toBe("11.0.0");
	});

	it("returns null when no versions match the range", async () => {
		const result = await Effect.runPromise(resolveLatestInRange(versionList, "12.0.0"));
		expect(result).toBeNull();
	});

	it("returns null for empty versions array", async () => {
		const result = await Effect.runPromise(resolveLatestInRange([], "10.28.2"));
		expect(result).toBeNull();
	});

	it("does not jump to next major version", async () => {
		const result = await Effect.runPromise(resolveLatestInRange(versionList, "10.27.0"));
		expect(result).toBe("10.29.1");
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// PnpmUpgrade service (Effect integration tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("PnpmUpgrade service", () => {
	/** Helper to extract the shell command from execCapture args */
	const getShellCmd = (_command: string, args?: ReadonlyArray<string>) => args?.[1] ?? "";

	/** Standard mock that handles npm view and corepack use */
	const makeMockExecCapture = (dir: string, opts?: { capturedCmds?: string[]; skipCorepack?: boolean }) => {
		return (_command: string, args?: ReadonlyArray<string>) => {
			const cmd = getShellCmd(_command, args);
			opts?.capturedCmds?.push(cmd);
			if (cmd.includes("npm view")) {
				return Effect.succeed({ exitCode: 0, stdout: versions, stderr: "" });
			}
			if (cmd.includes("corepack use") && !opts?.skipCorepack) {
				// Simulate corepack updating packageManager field
				const pkg = readPackageJson(dir);
				pkg.packageManager = "pnpm@10.29.1+sha512.fake";
				writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
			}
			return Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" });
		};
	};

	it("returns null when no pnpm fields in package.json", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", version: "1.0.0" });

		const result = await runWithService((s) => s.upgrade(dir));
		expect(result).toBeNull();
	});

	it("returns null when packageManager is not pnpm", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "yarn@4.0.0" });

		const result = await runWithService((s) => s.upgrade(dir));
		expect(result).toBeNull();
	});

	it("upgrades pnpm when newer version available in range", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "pnpm@10.28.2" });

		const capturedCmds: string[] = [];

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir, { capturedCmds }));

		expect(result).not.toBeNull();
		expect(result?.from).toBe("10.28.2");
		expect(result?.to).toBe("10.29.1");
		expect(result?.packageManagerUpdated).toBe(true);
		expect(capturedCmds).toContainEqual("corepack use pnpm@10.29.1");
	});

	it("returns null when already on latest in range", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "pnpm@10.29.1" });

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		expect(result).toBeNull();
	});

	it("updates devEngines.packageManager.version when present", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "test",
			packageManager: "pnpm@10.28.2",
			devEngines: {
				packageManager: { name: "pnpm", version: "10.28.2" },
			},
		});

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		expect(result).not.toBeNull();
		expect(result?.from).toBe("10.28.2");
		expect(result?.to).toBe("10.29.1");
		expect(result?.packageManagerUpdated).toBe(true);
		expect(result?.devEnginesUpdated).toBe(true);

		// Verify devEngines was updated in the file
		const pkg = readPackageJson(dir);
		expect(pkg.devEngines.packageManager.version).toBe("10.29.1");
	});

	it("preserves caret in devEngines version", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "test",
			packageManager: "pnpm@10.28.2",
			devEngines: {
				packageManager: { name: "pnpm", version: "^10.28.2" },
			},
		});

		await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		const pkg = readPackageJson(dir);
		expect(pkg.devEngines.packageManager.version).toBe("^10.29.1");
	});

	it("handles devEngines only (no packageManager field)", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "test",
			devEngines: {
				packageManager: { name: "pnpm", version: "10.28.2" },
			},
		});

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir, { skipCorepack: true }));

		expect(result).not.toBeNull();
		expect(result?.from).toBe("10.28.2");
		expect(result?.to).toBe("10.29.1");
		expect(result?.packageManagerUpdated).toBe(false);
		expect(result?.devEnginesUpdated).toBe(true);
	});

	it("skips devEngines when packageManager name is not pnpm", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "test",
			packageManager: "pnpm@10.28.2",
			devEngines: {
				packageManager: { name: "yarn", version: "4.0.0" },
			},
		});

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		expect(result).not.toBeNull();
		expect(result?.packageManagerUpdated).toBe(true);
		expect(result?.devEnginesUpdated).toBe(false);
	});

	it("detects tab indentation and preserves it", async () => {
		const dir = makeTempDir();
		// Write with tab indentation
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify(
				{
					name: "test",
					packageManager: "pnpm@10.28.2",
					devEngines: { packageManager: { name: "pnpm", version: "10.28.2" } },
				},
				null,
				"\t",
			)}\n`,
		);

		await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		const raw = readFileSync(join(dir, "package.json"), "utf-8");
		// Verify tab indentation is preserved
		expect(raw).toMatch(/^\t"/m);
	});

	it("detects space indentation and preserves it", async () => {
		const dir = makeTempDir();
		// Write with 2-space indentation
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify(
				{
					name: "test",
					packageManager: "pnpm@10.28.2",
					devEngines: { packageManager: { name: "pnpm", version: "10.28.2" } },
				},
				null,
				2,
			)}\n`,
		);

		await runWithService(
			(s) => s.upgrade(dir),
			(_command, args) => {
				const cmd = getShellCmd(_command, args);
				if (cmd.includes("npm view")) {
					return Effect.succeed({ exitCode: 0, stdout: versions, stderr: "" });
				}
				if (cmd.includes("corepack use")) {
					const pkg = readPackageJson(dir);
					pkg.packageManager = "pnpm@10.29.1+sha512.fake";
					// Simulate corepack preserving space indentation
					writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
				}
				return Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" });
			},
		);

		const raw = readFileSync(join(dir, "package.json"), "utf-8");
		// Verify space indentation is preserved (not tabs)
		expect(raw).toMatch(/^ {2}"/m);
		expect(raw).not.toMatch(/^\t"/m);
	});

	it("returns null when no newer version is available", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "pnpm@11.0.0" });

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		// 11.0.0 is the only stable version in 11.x range, so it's already latest
		expect(result).toBeNull();
	});

	it("returns null when no versions satisfy the range", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "pnpm@12.0.0" });

		const result = await runWithService((s) => s.upgrade(dir), makeMockExecCapture(dir));

		expect(result).toBeNull();
	});

	it("fails when package.json does not exist", async () => {
		const dir = makeTempDir();
		// No package.json written

		const result = await runWithServiceEither((s) => s.upgrade(dir));

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("FileSystemError");
		}
	});

	it("fails when package.json has invalid JSON", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "package.json"), "{ not valid json");

		const result = await runWithServiceEither((s) => s.upgrade(dir));

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("FileSystemError");
		}
	});

	it("fails when npm view returns invalid JSON", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "test", packageManager: "pnpm@10.28.2" });

		const result = await runWithServiceEither(
			(s) => s.upgrade(dir),
			(_command, args) => {
				const cmd = getShellCmd(_command, args);
				if (cmd.includes("npm view")) {
					return Effect.succeed({ exitCode: 0, stdout: "not json", stderr: "" });
				}
				return Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" });
			},
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("FileSystemError");
		}
	});
});
