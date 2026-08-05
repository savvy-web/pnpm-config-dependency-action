import type { ScriptResult } from "@effected/commands";
import { Effect, References } from "effect";
import { describe, expect, it } from "vitest";
import { runCommands } from "../../../src/steps/custom-commands.js";
import { fromMap } from "../../utils/spawner.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * runCommands shells out as `sh -c "<command>"`, so the scripted key is the
 * whole line. A non-zero exit is a RESULT for Run.collect, not a failure, which
 * is why the failure cases below script an exit code rather than a spawn error.
 */
const shLine = (command: string) => `sh -c ${command}`;

const failing = (stderr: string): ScriptResult => ({ exit: 1, stdout: "", stderr });

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("runCommands", () => {
	it("returns empty result for empty commands", async () => {
		const spawner = fromMap();
		const result = await Effect.runPromise(
			runCommands([]).pipe(Effect.provide(spawner.layer), Effect.provideService(References.MinimumLogLevel, "None")),
		);
		expect(result.successful).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it("runs each command sequentially", async () => {
		const spawner = fromMap();

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix", "pnpm test"]).pipe(
				Effect.provide(spawner.layer),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		// args[1] of `sh -c` is the actual command.
		expect(spawner.spawns.map((call) => call.args[1])).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.successful).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.failed).toEqual([]);
	});

	it("collects failed commands with error details", async () => {
		const spawner = fromMap(new Map([[shLine("pnpm lint:fix"), failing("lint errors")]]));

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix"]).pipe(
				Effect.provide(spawner.layer),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result.successful).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm lint:fix");
		expect(result.failed[0].error).toContain("lint errors");
	});

	it("continues after failure (all commands run)", async () => {
		const spawner = fromMap(new Map([[shLine("pnpm test"), failing("test fail")]]));

		const result = await Effect.runPromise(
			runCommands(["pnpm lint", "pnpm test", "pnpm build"]).pipe(
				Effect.provide(spawner.layer),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result.successful).toEqual(["pnpm lint", "pnpm build"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm test");
	});
});
