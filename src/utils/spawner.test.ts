/**
 * A scripted `ChildProcessSpawner` for tests.
 *
 * Replaces the deleted `CommandRunnerTest` from
 * `@savvy-web/github-action-effects`. `@effected/commands` deliberately ships
 * no runner service to stub — `Run` is free functions over core's
 * `ChildProcessSpawner`, so the seam a test replaces is the spawner itself.
 *
 * Responses are keyed by the full command line (`"git fetch origin"`), the same
 * key shape the predecessor's double used, so migrated suites keep their
 * scripts verbatim.
 *
 * @module utils/spawner.test
 */

import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

/** One scripted process result. */
export interface ScriptedResponse {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** A recorded invocation, in call order. */
export interface RecordedCall {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	/** The full command line, the key `responses` is looked up by. */
	readonly line: string;
	/** The working directory the command was anchored at, when one was set. */
	readonly cwd: string | undefined;
}

export interface ScriptedSpawner {
	readonly calls: Array<RecordedCall>;
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
}

const encoder = new TextEncoder();

/** The command line a `Command` represents, for keying and recording. */
export const commandLine = (command: ChildProcess.Command): string =>
	ChildProcess.isStandardCommand(command) ? [command.command, ...command.args].join(" ") : "<piped>";

/**
 * A spawner answering from `responses`, keyed by full command line.
 *
 * An unscripted command answers `fallback` (exit 0, empty output by default)
 * rather than dying: these suites script only the commands they assert on, and
 * the surrounding git plumbing (`fetch`, `checkout`) is incidental to every one
 * of them. Pass a non-zero `fallback` for a suite about failure handling.
 */
export const scriptedSpawner = (
	responses?: ReadonlyMap<string, ScriptedResponse>,
	fallback: ScriptedResponse = { exitCode: 0, stdout: "", stderr: "" },
): ScriptedSpawner => {
	const calls: Array<RecordedCall> = [];

	const spawn = (command: ChildProcess.Command) =>
		Effect.sync(() => {
			const line = commandLine(command);
			if (ChildProcess.isStandardCommand(command)) {
				calls.push({ command: command.command, args: command.args, line, cwd: command.options.cwd });
			}
			const response = responses?.get(line) ?? fallback;

			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(1),
				exitCode: Effect.succeed(response.exitCode as never),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain as never,
				stdout: Stream.succeed(encoder.encode(response.stdout)),
				stderr: Stream.succeed(encoder.encode(response.stderr)),
				all: Stream.succeed(encoder.encode(response.stdout + response.stderr)),
				getInputFd: () => Sink.drain as never,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void as never),
			});
		});

	return {
		calls,
		layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn as never)),
	};
};

describe("scriptedSpawner", () => {
	it("answers a scripted command and records the call", async () => {
		const spawner = scriptedSpawner(new Map([["git status", { exitCode: 0, stdout: " M a.ts\n", stderr: "" }]]));

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* service.string(ChildProcess.make("git", ["status"]));
			}).pipe(Effect.provide(spawner.layer)),
		);

		expect(out).toContain("M a.ts");
		expect(spawner.calls[0]?.line).toBe("git status");
	});

	it("preserves leading whitespace, which porcelain parsing depends on", async () => {
		const spawner = scriptedSpawner(new Map([["git status", { exitCode: 0, stdout: " M a.ts\n", stderr: "" }]]));

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* ChildProcessSpawner.ChildProcessSpawner;
				return yield* service.string(ChildProcess.make("git", ["status"]));
			}).pipe(Effect.provide(spawner.layer)),
		);

		expect(out.startsWith(" M")).toBe(true);
	});
});
