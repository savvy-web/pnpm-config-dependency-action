/**
 * Fixture loader for integration tests.
 *
 * Copies a committed fixture from `__test__/integration/fixtures/<name>`
 * into a fresh temp directory and returns the temp path. Tests can then
 * mutate the temp copy without polluting the committed fixture.
 */

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

export interface LoadedFixture {
	readonly path: string;
}

export const loadFixture = (name: string): LoadedFixture => {
	const src = join(FIXTURES_DIR, name);
	const dst = mkdtempSync(join(tmpdir(), `pcda-${name}-`));
	cpSync(src, dst, { recursive: true });
	return { path: dst };
};
