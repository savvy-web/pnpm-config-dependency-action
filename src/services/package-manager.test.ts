import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { PackageManagerDetector, WorkspaceRoot } from "@effected/workspaces";
import { Cause, Effect, Exit, Layer, Option, References } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInputError } from "../errors/errors.js";
import { detectPackageManager } from "./package-manager.js";

let root: string;

const layer = Layer.mergeAll(
	PackageManagerDetector.layer,
	WorkspaceRoot.layer.pipe(Layer.provide(NodeServices.layer)),
).pipe(Layer.provide(NodeServices.layer));

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const detect = (cwd: string) =>
	detectPackageManager(cwd).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pm-detect-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
	it("detects bun from devEngines.packageManager", async () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "root",
				workspaces: ["."],
				devEngines: { packageManager: { name: "bun", version: "1.3.14" } },
			}),
		);
		// @effected/workspaces' detector requires a bun lockfile conjoined with the
		// manifest naming bun (the same lockfile+manifest conjunction it has always
		// required for yarn) — devEngines.packageManager alone is no longer sufficient.
		writeFileSync(join(root, "bun.lock"), "");

		const result = await run(detect(root));

		expect(result.pm).toBe("bun");
		expect(result.version).toBe("1.3.14");
		expect(result.root).toBe(root);
	});

	it("detects pnpm from pnpm-workspace.yaml", async () => {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
		writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");

		const result = await run(detect(root));

		expect(result.pm).toBe("pnpm");
	});

	it("detects npm from the workspaces field", async () => {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));

		const result = await run(detect(root));

		expect(result.pm).toBe("npm");
	});

	it("fails with InvalidInputError on yarn", async () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "root", workspaces: ["."], packageManager: "yarn@4.10.0" }),
		);
		writeFileSync(join(root, "yarn.lock"), "");

		const exit = await Effect.runPromiseExit(detect(root));

		if (!Exit.isFailure(exit)) {
			throw new Error("Expected Failure exit");
		}

		expect(Cause.hasFails(exit.cause)).toBe(true);
		const errorOption = Cause.findErrorOption(exit.cause);
		if (Option.isNone(errorOption)) {
			throw new Error("Expected Fail cause");
		}

		const error = errorOption.value;
		expect(error).toBeInstanceOf(InvalidInputError);
		if (error instanceof InvalidInputError) {
			expect(error.reason).toContain("Detected yarn");
		}
	});

	it("fails with InvalidInputError when nothing is detectable", async () => {
		const exit = await Effect.runPromiseExit(detect(root));

		if (!Exit.isFailure(exit)) {
			throw new Error("Expected Failure exit");
		}

		expect(Cause.hasFails(exit.cause)).toBe(true);
		const errorOption = Cause.findErrorOption(exit.cause);
		if (Option.isNone(errorOption)) {
			throw new Error("Expected Fail cause");
		}

		const error = errorOption.value;
		expect(error).toBeInstanceOf(InvalidInputError);
	});
});
