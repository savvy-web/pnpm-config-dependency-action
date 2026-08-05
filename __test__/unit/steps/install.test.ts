import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, References } from "effect";
import { describe, expect, it } from "vitest";
import { runInstall } from "../../../src/steps/install.js";
import { fromMap } from "../../utils/spawner.js";

/**
 * Records the command lines runInstall spawns.
 *
 * The predecessor's runner split streaming (`exec`) from capturing
 * (`execCapture`) and this suite asserted runInstall used the streaming half.
 * `@effected/commands` has no such split — every `Run` combinator collects — so
 * that invariant no longer exists and the surviving assertion is which commands
 * run, in what order.
 */
const run = (pm: "pnpm" | "bun" | "npm", workspaceRoot = "/ws") => {
	const spawner = fromMap();
	return Effect.runPromise(
		runInstall(pm, workspaceRoot).pipe(
			Effect.provide(spawner.layer),
			Effect.provideService(References.MinimumLogLevel, "None"),
		),
	).then(() => ({
		exec: spawner.spawns.map((call) => [call.command, ...call.args].join(" ")),
		cwds: spawner.spawns.map((call) => call.cwd),
	}));
};

describe("runInstall", () => {
	it("regenerates the lockfile for pnpm", async () => {
		const calls = await run("pnpm");

		expect(calls.exec).toEqual(["pnpm clean --lockfile", "pnpm install --frozen-lockfile=false"]);
	});

	it("forces a re-resolve for bun", async () => {
		const calls = await run("bun");

		expect(calls.exec).toEqual(["bun install --force"]);
	});

	it("runs every command at the workspace root", async () => {
		// `runInstall` used to default this parameter to `process.cwd()`. That is
		// the shape of four separate defects on this branch, so the root being
		// honoured is asserted rather than assumed — and `/ws` is not a directory
		// the test process could reach by accident.
		const calls = await run("pnpm", "/ws");

		expect(calls.cwds).toEqual(["/ws", "/ws"]);
	});

	it("deletes the lockfile and installs for npm", async () => {
		// The removal goes through node:fs, not a shelled-out `rm`, so assert the
		// file is actually gone rather than that a command was issued — `rm` does
		// not exist on a Windows runner, and the pnpm path is deliberately
		// platform-agnostic for the same reason.
		//
		// No `process.chdir` here. These two tests used to chdir into the temp
		// directory purely to reach the `process.cwd()` default; with the root
		// required they pass it, which is both what production does and a stronger
		// assertion — the unlink has to resolve against the ARGUMENT, since the
		// test process is never inside this directory.
		const root = mkdtempSync(join(tmpdir(), "run-install-"));
		try {
			writeFileSync(join(root, "package-lock.json"), "{}");

			const calls = await run("npm", root);

			expect(existsSync(join(root, "package-lock.json"))).toBe(false);
			expect(calls.exec).toEqual(["npm install"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not fail for npm when there is no lockfile to remove", async () => {
		const root = mkdtempSync(join(tmpdir(), "run-install-"));
		try {
			const calls = await run("npm", root);

			expect(calls.exec).toEqual(["npm install"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
