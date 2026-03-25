import type { CommandRunnerError } from "@savvy-web/github-action-effects";
import { CommandRunner, CommandRunnerTest } from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { runCommands } from "./program.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a mock CommandRunner service.
 */
type CommandRunnerShape = Context.Tag.Service<typeof CommandRunner>;

const makeTestRunner = (
	overrides: Partial<{
		exec: CommandRunnerShape["exec"];
		execCapture: CommandRunnerShape["execCapture"];
		execJson: CommandRunnerShape["execJson"];
		execLines: CommandRunnerShape["execLines"];
	}> = {},
): Layer.Layer<CommandRunner> => {
	const service: CommandRunnerShape = {
		exec: () => Effect.succeed(0),
		execCapture: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
		execJson: () => Effect.succeed(null as never),
		execLines: () => Effect.succeed([]),
		...overrides,
	};
	return Layer.succeed(CommandRunner, service);
};

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("runCommands", () => {
	it("returns empty result for empty commands", async () => {
		const layer = CommandRunnerTest.empty();
		const result = await Effect.runPromise(
			runCommands([]).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);
		expect(result.successful).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it("runs each command sequentially", async () => {
		const commandOrder: string[] = [];

		const layer = makeTestRunner({
			execCapture: (_cmd: string, args?: ReadonlyArray<string>) => {
				// The command is passed via sh -c, so args[1] is the actual command
				const actualCmd = args?.[1] ?? "";
				commandOrder.push(actualCmd as string);
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
			},
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix", "pnpm test"]).pipe(
				Effect.provide(layer),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(commandOrder).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.successful).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.failed).toEqual([]);
	});

	it("collects failed commands with error details", async () => {
		const layer = makeTestRunner({
			execCapture: () =>
				Effect.fail({
					_tag: "CommandRunnerError",
					command: "sh",
					exitCode: 1,
					reason: "lint errors",
				} as unknown as CommandRunnerError),
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix"]).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.successful).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm lint:fix");
		expect(result.failed[0].error).toContain("lint errors");
	});

	it("continues after failure (all commands run)", async () => {
		const layer = makeTestRunner({
			execCapture: (_cmd: string, args?: ReadonlyArray<string>) => {
				const actualCmd = args?.[1] ?? "";
				if (actualCmd === "pnpm test") {
					return Effect.fail({
						_tag: "CommandRunnerError",
						command: "sh",
						exitCode: 1,
						reason: "test fail",
					} as unknown as CommandRunnerError);
				}
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
			},
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint", "pnpm test", "pnpm build"]).pipe(
				Effect.provide(layer),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(result.successful).toEqual(["pnpm lint", "pnpm build"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm test");
	});
});
