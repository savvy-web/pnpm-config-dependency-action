/**
 * Detect the package manager a workspace is using, once per run.
 *
 * @module services/package-manager
 */

import type { PackageManagerEvidence } from "@effected/workspaces";
import { PackageManagerDetector, WorkspaceRoot } from "@effected/workspaces";
import { Effect, Option } from "effect";

import { InvalidInputError } from "../errors/errors.js";

/**
 * The package managers this action supports.
 *
 * Yarn is detected upstream but not supported here: nothing in the config-dep,
 * install or upgrade paths is wired or tested for it.
 */
export type SupportedPm = "pnpm" | "bun" | "npm";

/** The package manager this run is operating on, resolved once. */
export interface DetectedPm {
	readonly pm: SupportedPm;
	readonly version: string | undefined;
	readonly root: string;
	/**
	 * The marker that decided `pm`, straight from the detector.
	 *
	 * This is the detector's own answer, not a re-derivation. It replaces a local
	 * `describePmEvidence` helper that re-read the manifest and re-implemented the
	 * priority order to guess — and got it wrong whenever the real rule was a
	 * conjunction (a stray lockfile plus a manifest field), reporting a confident
	 * wrong signal while the detector itself decided correctly.
	 */
	readonly evidence: PackageManagerEvidence;
}

/**
 * Detect the package manager for the workspace.
 *
 * Delegates to workspaces-effect's `PackageManagerDetector`, which is also what
 * `LockfileReader` and `PointInTimeWorkspace` consult internally — so the PM the
 * action dispatches on is always the one those libraries parse for. It reads
 * `devEngines.packageManager` first, then falls back to lockfile and config-file
 * presence.
 *
 * `WorkspaceRoot.find` and `PackageManagerDetector.detect` share the same
 * marker checks (`pnpm-workspace.yaml`, `package.json`'s `workspaces` field),
 * so a `WorkspaceRootNotFoundError` and a `PackageManagerDetectionError` are
 * mapped to `InvalidInputError` through one shared handler below rather than
 * two — both upstream errors carry the same `reason` / `searchPath` shape.
 *
 * The kit has no `ActionInputError` successor — action inputs are `Config`
 * values and their failures are core `ConfigError`. This failure is not an
 * input-parse failure though: the workspace on disk is the thing being
 * rejected, so it uses this repo's own `InvalidInputError` rather than
 * pretending to be a `ConfigError`.
 */
export const detectPackageManager = (
	cwd?: string,
): Effect.Effect<DetectedPm, InvalidInputError, PackageManagerDetector | WorkspaceRoot> =>
	Effect.gen(function* () {
		const workspaceRoot = yield* WorkspaceRoot;
		const detector = yield* PackageManagerDetector;

		const startDir = cwd ?? process.cwd();
		const root = yield* workspaceRoot.find(startDir);
		const detected = yield* detector.detect(root);

		if (detected.name === "yarn") {
			return yield* Effect.fail(
				new InvalidInputError({
					field: "workspace",
					reason: "Detected yarn, which this action does not support. Supported: pnpm, bun, npm.",
					value: root,
				}),
			);
		}

		return { pm: detected.name, version: Option.getOrUndefined(detected.version), root, evidence: detected.evidence };
	}).pipe(
		Effect.mapError((error) =>
			error instanceof InvalidInputError
				? error
				: new InvalidInputError({
						field: "workspace",
						reason: `Could not detect a package manager: ${error.message}`,
						value: "searchPath" in error ? error.searchPath : "root" in error ? error.root : "",
					}),
		),
	);
