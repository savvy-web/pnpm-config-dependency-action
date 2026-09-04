import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Directory names reserved for helpers, fixtures and mocks. A `*.test.ts`
 * placed under one is not a test this repo will run, and the failure mode is
 * silence: the suite shrinks while the aggregate coverage gate stays green, so
 * nothing reports it.
 *
 * **This guard is deliberately STRICTER than the runner, and the comment here
 * used to get that backwards.** It claimed to mirror `TEST_HELPER_DIRS` in
 * `@vitest-agent/sdk`'s `utils/test-location.js`, rule
 * `segments.slice(1, -1).some(...)` — but `@vitest-agent/sdk` is not installed
 * (only `cli`, `mcp` and `plugin` are), and the installed plugin excludes only
 * the **direct child of `__test__`**. Measured by planting a `probe.test.ts`
 * and listing with `pnpm exec vitest list --filesOnly`: probes under
 * `__test__/unit/steps/fixtures/` and `__test__/unit/utils/` are collected,
 * one under `__test__/fixtures/` is not.
 *
 * So the any-depth check below is this repo's own convention, not a mirror of
 * anything. Keep it: it is fail-safe (it can only over-exclude), it survives
 * the plugin changing its rule in either direction, and a nested `utils/`
 * holding a suite is a naming mistake regardless of whether the runner
 * happens to collect it.
 */
const RESERVED_HELPER_DIRS = ["fixtures", "snapshots", "utils"];

const TEST_ROOT = join(fileURLToPath(new URL("../../", import.meta.url)), "__test__");

/** Every `*.test.ts` beneath `__test__`, as paths relative to `__test__`. */
const findTestFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(dir, { withFileTypes: true });
	const found: Array<string> = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await findTestFiles(full)));
		} else if (entry.name.endsWith(".test.ts")) {
			found.push(relative(TEST_ROOT, full));
		}
	}
	return found;
};

describe("test collection", () => {
	it("collects every test file — none sits under a reserved helper directory", async () => {
		const testFiles = await findTestFiles(TEST_ROOT);

		// Guards the guard: a walker that found nothing would pass vacuously.
		expect(testFiles.length).toBeGreaterThan(30);

		const excluded = testFiles.filter((file) =>
			file
				.split(sep)
				.slice(0, -1)
				.some((segment) => RESERVED_HELPER_DIRS.includes(segment)),
		);

		expect(excluded).toEqual([]);
	});
});
