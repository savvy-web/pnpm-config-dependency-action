import { Effect, Layer, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import { FileSystemError } from "../../../src/errors/errors.js";
import type { PackageManagerUpgradeOutcome } from "../../../src/services/package-manager-upgrade.js";
import { PackageManagerUpgrade } from "../../../src/services/package-manager-upgrade.js";
import { upgradePackageManagerStep } from "../../../src/steps/upgrade-package-manager.js";

/**
 * Additive to `program.inner.test.ts`, which remains authoritative over the log
 * contract as a whole. What this suite adds is per-outcome coverage of the step
 * in isolation — every branch of `PackageManagerUpgradeOutcome`, including the
 * ones the composition suite only exercises for pnpm.
 *
 * The level assertions are the point: `unsatisfiable` is the one non-benign skip
 * and must warn, while `disabled` / `already-current` must stay at info. A run
 * that scrolls an acceptance signal past at the same level as a routine skip is
 * the failure this distinction exists to prevent.
 */

/**
 * Capture the log stream with its levels — and count service invocations.
 *
 * The count exists because the disabled-path assertion is otherwise vacuous: the
 * result shape a short-circuit produces is one a *called* service could return
 * identically, so asserting the shape alone cannot tell "never called" from
 * "called and answered that". Only the call count discriminates.
 */
const runStep = async (mode: string, outcome: PackageManagerUpgradeOutcome | { fail: string }) => {
	const logs: Array<{ level: string; message: string }> = [];
	let calls = 0;

	const service = Layer.succeed(PackageManagerUpgrade, {
		upgrade: () =>
			Effect.suspend(() => {
				calls += 1;
				return "fail" in outcome
					? Effect.fail(new FileSystemError({ operation: "write", path: "/ws/package.json", reason: outcome.fail }))
					: Effect.succeed(outcome);
			}),
	});

	const captureLogger = Layer.succeed(
		References.CurrentLoggers,
		new Set([
			Logger.make(({ logLevel, message }) => {
				const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
				logs.push({ level: logLevel, message: text });
			}),
		]),
	);

	const result = await Effect.runPromise(
		upgradePackageManagerStep(mode, "pnpm", "/ws").pipe(
			Effect.provide(service),
			Effect.provide(captureLogger),
			Effect.provideService(References.MinimumLogLevel, "Info"),
		),
	);
	return { result, logs, calls };
};

const skipped = (kind: "disabled" | "no-reference" | "unsatisfiable" | "already-current" | "error", reason: string) =>
	({
		applied: false,
		pm: "pnpm",
		reference: "11.0.0",
		referenceSource: "devEngines",
		targetRange: "^11.0.0",
		kind,
		reason,
	}) as PackageManagerUpgradeOutcome;

describe("upgradePackageManagerStep", () => {
	it("skips without calling the service when the mode is false", async () => {
		// The call count is the load-bearing assertion, and the reason is worth
		// stating: the outcome handed to the double here is itself a `disabled`
		// skip, so `updates: []` and that exact `skipReason` are what a CALLED
		// service would produce too. The previous version asserted only those and
		// carried a comment claiming the double "would die if called" — it would
		// not; it is a plain `Layer.succeed`. The test could not fail for the
		// reason it existed.
		const { result, logs, calls } = await runStep("false", skipped("disabled", "unused"));

		expect(calls).toBe(0);
		expect(result.updates).toEqual([]);
		expect(result.skipReason).toBe("disabled (upgrade-package-manager: false)");
		expect(logs.every((l) => l.level !== "Warn")).toBe(true);
	});

	it("does call the service for any non-false mode", async () => {
		// The control. Without it, `calls === 0` above would pass just as well
		// against a step that never calls the service at all.
		const { calls } = await runStep("auto", skipped("already-current", "up to date"));

		expect(calls).toBe(1);
	});

	it("reports an applied upgrade as a packageManager-typed update", async () => {
		const { result } = await runStep("auto", {
			applied: true,
			pm: "pnpm",
			reference: "11.0.0",
			referenceSource: "devEngines",
			targetRange: "^11.0.0",
			from: "11.0.0",
			to: "11.20.0",
			packageManagerUpdated: true,
			devEnginesUpdated: true,
			added: false,
		});

		expect(result.updates).toEqual([
			{ dependency: "pnpm", from: "11.0.0", to: "11.20.0", type: "packageManager", package: null },
		]);
		expect(result.skipReason).toBeNull();
	});

	it("WARNS on unsatisfiable — the acceptance signal", async () => {
		// A range typed for a different package manager (a pnpm ^11 in a bun repo)
		// must not scroll past at the same level as a benign skip.
		const { logs } = await runStep("^11.0.0", skipped("unsatisfiable", "no release satisfies the range"));

		expect(logs.some((l) => l.level === "Warn")).toBe(true);
		expect(
			logs
				.filter((l) => l.level === "Warn")
				.map((l) => l.message)
				.join("\n"),
		).toContain("SKIPPED");
	});

	it("stays at INFO for already-current", async () => {
		const { logs } = await runStep("auto", skipped("already-current", "already current"));

		expect(logs.some((l) => l.level === "Warn")).toBe(false);
		expect(logs.some((l) => l.message.includes("SKIPPED"))).toBe(true);
	});

	it("stays at INFO for no-reference", async () => {
		const { logs } = await runStep("auto", skipped("no-reference", "no packageManager entry"));

		expect(logs.some((l) => l.level === "Warn")).toBe(false);
	});

	it("degrades a read/write failure to a warning and an error-kind skip", async () => {
		// The step's error channel is `never`; a service failure must fold into an
		// outcome rather than aborting a run whose dependency updates are fine.
		const { result, logs } = await runStep("auto", { fail: "EACCES" });

		expect(result.updates).toEqual([]);
		expect(result.skipReason).toContain("read/write error");
		expect(logs.some((l) => l.level === "Warn")).toBe(true);
	});
});
