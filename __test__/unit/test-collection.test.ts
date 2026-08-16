import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Directory names `@vitest-agent/plugin` reserves for helpers, fixtures and
 * mocks. A `*.test.ts` whose path crosses one of these is classified
 * `excluded` and is **silently never collected** — the suite shrinks and the
 * aggregate coverage gate stays green, so nothing reports it.
 *
 * Mirrors `TEST_HELPER_DIRS` in `@vitest-agent/sdk`'s `utils/test-location.js`
 * (the rule is `segments.slice(1, -1).some((s) => TEST_HELPER_DIRS.includes(s))`).
 * Hardcoded rather than imported because the SDK is a transitive dependency of
 * the plugin and is not resolvable from this package's root.
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
