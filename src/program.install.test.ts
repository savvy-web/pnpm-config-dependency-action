import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, References } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "./program.js";
import { scriptedSpawner } from "./utils/spawner.test.js";

/**
 * Records the command lines runInstall spawns.
 *
 * The predecessor's runner split streaming (`exec`) from capturing
 * (`execCapture`) and this suite asserted runInstall used the streaming half.
 * `@effected/commands` has no such split — every `Run` combinator collects — so
 * that invariant no longer exists and the surviving assertion is which commands
 * run, in what order.
 */
const run = (pm: "pnpm" | "bun" | "npm") => {
	const spawner = scriptedSpawner();
	return Effect.runPromise(
		runInstall(pm).pipe(Effect.provide(spawner.layer), Effect.provideService(References.MinimumLogLevel, "None")),
	).then(() => ({ exec: spawner.calls.map((call) => call.line) }));
};

/** Restored after any test that chdirs into a temp workspace. */
let cwd: string | null = null;

afterEach(() => {
	if (cwd !== null) {
		process.chdir(cwd);
		cwd = null;
	}
});

describe("runInstall", () => {
	it("regenerates the lockfile for pnpm", async () => {
		const calls = await run("pnpm");

		expect(calls.exec).toEqual(["pnpm clean --lockfile", "pnpm install --frozen-lockfile=false"]);
	});

	it("forces a re-resolve for bun", async () => {
		const calls = await run("bun");

		expect(calls.exec).toEqual(["bun install --force"]);
	});

	it("deletes the lockfile and installs for npm", async () => {
		// The removal goes through node:fs, not a shelled-out `rm`, so assert the
		// file is actually gone rather than that a command was issued — `rm` does
		// not exist on a Windows runner, and the pnpm path is deliberately
		// platform-agnostic for the same reason.
		cwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "run-install-"));
		process.chdir(root);
		writeFileSync(join(root, "package-lock.json"), "{}");

		const calls = await run("npm");

		expect(existsSync(join(root, "package-lock.json"))).toBe(false);
		expect(calls.exec).toEqual(["npm install"]);

		rmSync(root, { recursive: true, force: true });
	});

	it("does not fail for npm when there is no lockfile to remove", async () => {
		cwd = process.cwd();
		const root = mkdtempSync(join(tmpdir(), "run-install-"));
		process.chdir(root);

		const calls = await run("npm");

		expect(calls.exec).toEqual(["npm install"]);

		rmSync(root, { recursive: true, force: true });
	});
});
