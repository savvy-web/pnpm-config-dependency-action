import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner as CommandRunnerService } from "@savvy-web/github-action-effects";
import { CommandRunner } from "@savvy-web/github-action-effects";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseConfigEntry, updateConfigDeps } from "./config.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

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
): CommandRunnerService => ({
	exec: (_cmd, _args) => Effect.succeed(0),
	execCapture: execCaptureOverride ?? defaultExecCapture,
	execJson: (_cmd, _args, _schema) => Effect.die("not implemented"),
	execLines: (_cmd, _args) => Effect.succeed([]),
});

const runWithRunner = <A, E>(
	effect: Effect.Effect<A, E, CommandRunner>,
	execCaptureOverride?: (
		command: string,
		args?: ReadonlyArray<string>,
	) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, never>,
) => {
	const layer = Layer.succeed(CommandRunner, makeRunner(execCaptureOverride));
	return Effect.runPromise(effect.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)));
};

// ══════════════════════════════════════════════════════════════════════════════
// parseConfigEntry
// ══════════════════════════════════════════════════════════════════════════════

describe("parseConfigEntry", () => {
	it("parses version with hash", () => {
		const result = parseConfigEntry("0.6.3+sha512-abc==");
		expect(result).toEqual({ version: "0.6.3", hash: "sha512-abc==" });
	});

	it("parses version without hash", () => {
		const result = parseConfigEntry("0.6.3");
		expect(result).toEqual({ version: "0.6.3", hash: null });
	});

	it("handles hash containing + chars (base64)", () => {
		const result = parseConfigEntry("0.6.3+sha512-ab+cd/ef==");
		expect(result).toEqual({ version: "0.6.3", hash: "sha512-ab+cd/ef==" });
	});

	it("returns null for empty string", () => {
		expect(parseConfigEntry("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(parseConfigEntry("   ")).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// updateConfigDeps (Effect integration tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("updateConfigDeps", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "config-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const writeWorkspaceYaml = (content: string) => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), content, "utf-8");
	};

	const readWorkspaceYaml = () => {
		return parse(readFileSync(join(tempDir, "pnpm-workspace.yaml"), "utf-8"));
	};

	const makeNpmViewResponse = (version: string, integrity: string) =>
		JSON.stringify({ version, "dist.integrity": integrity });

	it("returns empty array when no deps provided", async () => {
		const result = await runWithRunner(updateConfigDeps([]));
		expect(result).toEqual([]);
	});

	it("returns empty array when no workspace yaml exists", async () => {
		const result = await runWithRunner(updateConfigDeps(["typescript"], tempDir));
		expect(result).toEqual([]);
	});

	it("returns empty array when no configDependencies section", async () => {
		writeWorkspaceYaml(`packages:\n  - "pkgs/*"\n`);

		const result = await runWithRunner(updateConfigDeps(["typescript"], tempDir));
		expect(result).toEqual([]);
	});

	it("skips dep not in configDependencies", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n`);

		const result = await runWithRunner(updateConfigDeps(["nonexistent"], tempDir));
		expect(result).toEqual([]);
	});

	it("updates single dep when newer version available", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "@savvy-web/silk": "0.6.3+sha512-oldHash=="\n`);

		const result = await runWithRunner(
			updateConfigDeps(["@savvy-web/silk"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view @savvy-web/silk")) {
					return makeNpmViewResponse("0.7.0", "sha512-newHash==");
				}
				return "ok";
			}),
		);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			dependency: "@savvy-web/silk",
			from: "0.6.3",
			to: "0.7.0",
			type: "config",
			package: null,
		});

		// Verify YAML was updated
		const yaml = readWorkspaceYaml();
		expect(yaml.configDependencies["@savvy-web/silk"]).toBe("0.7.0+sha512-newHash==");
	});

	it("skips dep when already on latest version", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.4.0+sha512-existingHash=="\n`);

		const result = await runWithRunner(
			updateConfigDeps(["typescript"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view typescript")) {
					return makeNpmViewResponse("5.4.0", "sha512-existingHash==");
				}
				return "ok";
			}),
		);

		expect(result).toHaveLength(0);
	});

	it("updates multiple deps", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n  "@biomejs/biome": "1.5.0+sha512-oldHash=="\n`);

		const result = await runWithRunner(
			updateConfigDeps(["typescript", "@biomejs/biome"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view typescript")) {
					return makeNpmViewResponse("5.4.0", "sha512-tsHash==");
				}
				if (argStr.includes("npm view @biomejs/biome")) {
					return makeNpmViewResponse("1.6.1", "sha512-biomeHash==");
				}
				return "ok";
			}),
		);

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.dependency === "typescript")?.to).toBe("5.4.0");
		expect(result.find((r) => r.dependency === "@biomejs/biome")?.to).toBe("1.6.1");
	});

	it("continues when npm query fails for one dep", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "bad-pkg": "1.0.0"\n  "good-pkg": "1.0.0"\n`);

		const result = await runWithRunner(updateConfigDeps(["bad-pkg", "good-pkg"], tempDir), (_cmd, args) => {
			const argStr = args?.join(" ") ?? "";
			if (argStr.includes("npm view bad-pkg")) {
				return Effect.fail({ command: "npm view", stderr: "not found", exitCode: 1 });
			}
			if (argStr.includes("npm view good-pkg")) {
				return Effect.succeed({ exitCode: 0, stdout: makeNpmViewResponse("2.0.0", "sha512-goodHash=="), stderr: "" });
			}
			return Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" });
		});

		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("good-pkg");
	});

	it("preserves other yaml keys", async () => {
		writeWorkspaceYaml(
			[
				`packages:`,
				`  - "pkgs/*"`,
				`  - "apps/*"`,
				`onlyBuiltDependencies:`,
				`  - sharp`,
				`configDependencies:`,
				`  typescript: "5.3.3"`,
				``,
			].join("\n"),
		);

		await runWithRunner(
			updateConfigDeps(["typescript"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view typescript")) {
					return makeNpmViewResponse("5.4.0", "sha512-tsHash==");
				}
				return "ok";
			}),
		);

		const yaml = readWorkspaceYaml();
		expect(yaml.packages).toBeDefined();
		expect(yaml.onlyBuiltDependencies).toBeDefined();
		expect(yaml.configDependencies.typescript).toBe("5.4.0+sha512-tsHash==");
	});

	it("reports clean versions in from/to (strips hash)", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "@savvy-web/silk": "0.6.3+sha512-P2oTH3CRDxvEqVtavf5adiX2B4=="\n`);

		const result = await runWithRunner(
			updateConfigDeps(["@savvy-web/silk"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view @savvy-web/silk")) {
					return makeNpmViewResponse("0.7.0", "sha512-newHashValue==");
				}
				return "ok";
			}),
		);

		expect(result).toHaveLength(1);
		// from should be clean version (no hash)
		expect(result[0].from).toBe("0.6.3");
		// to should be clean version (no hash)
		expect(result[0].to).toBe("0.7.0");
	});

	it("handles config dep without hash suffix", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n`);

		const result = await runWithRunner(
			updateConfigDeps(["typescript"], tempDir),
			makeExecCapture((_cmd, args) => {
				const argStr = args?.join(" ") ?? "";
				if (argStr.includes("npm view typescript")) {
					return makeNpmViewResponse("5.4.0", "sha512-tsHash==");
				}
				return "ok";
			}),
		);

		expect(result).toHaveLength(1);
		expect(result[0].from).toBe("5.3.3");
		expect(result[0].to).toBe("5.4.0");

		// YAML entry should have the full integrity hash
		const yaml = readWorkspaceYaml();
		expect(yaml.configDependencies.typescript).toBe("5.4.0+sha512-tsHash==");
	});
});
