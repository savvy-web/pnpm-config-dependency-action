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

/** Capture the log stream with its levels, which is what the assertions are about. */
const runStep = async (mode: string, outcome: PackageManagerUpgradeOutcome | { fail: string }) => {
	const logs: Array<{ level: string; message: string }> = [];

	const service = Layer.succeed(PackageManagerUpgrade, {
		upgrade: () =>
			"fail" in outcome
				? Effect.fail(new FileSystemError({ operation: "write", path: "/ws/package.json", reason: outcome.fail }))
				: Effect.succeed(outcome),
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
	return { result, logs };
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
		// The double would die if `upgrade` were called, so this also proves the
		// disabled branch short-circuits rather than resolving an outcome.
		const { result, logs } = await runStep("false", skipped("disabled", "unused"));

		expect(result.updates).toEqual([]);
		expect(result.skipReason).toBe("disabled (upgrade-package-manager: false)");
		expect(logs.every((l) => l.level !== "Warn")).toBe(true);
	});

	it("reports an applied upgrade as a config-typed update", async () => {
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
			{ dependency: "pnpm", from: "11.0.0", to: "11.20.0", type: "config", package: null },
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
