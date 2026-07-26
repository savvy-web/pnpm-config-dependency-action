/**
 * Shared `ScriptedSpawner` adapter for suites that script commands by line.
 *
 * `@effected/commands` ships the fixture itself — this only adapts its lookup.
 * The kit records structured spawns (`command`, `args`, `cwd`, `env`, …) while
 * these suites express their fixtures as a map keyed by the full command line,
 * so the join happens here rather than being copied into every consumer.
 *
 * Lives in `__test__/utils/` because `AgentPlugin.discover()` reserves that
 * directory for helper modules and excludes it from the test include.
 *
 * @module utils/spawner
 */

import type { ScriptResult } from "@effected/commands";
import { ScriptedSpawner } from "@effected/commands";

/**
 * A spawner answering from `responses`, keyed by the full command line.
 *
 * An unscripted command answers `fallback` (a bare zero-exit by default) rather
 * than dying: these suites script only the commands they assert on, and the
 * surrounding git plumbing is incidental to most of them. Pass a non-zero
 * `fallback` for a suite about failure handling.
 */
export const fromMap = (responses?: ReadonlyMap<string, ScriptResult>, fallback: ScriptResult = {}): ScriptedSpawner =>
	ScriptedSpawner.make((command, args) => responses?.get([command, ...args].join(" ")) ?? fallback);
