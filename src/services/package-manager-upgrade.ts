/**
 * PackageManagerUpgrade service for package-manager self-upgrade operations.
 *
 * Generalizes the pnpm-only `PnpmUpgrade` service to any package manager this
 * action supports (`SupportedPm`: pnpm, bun, npm). All three are published on
 * npm, so the same registry lookup and range logic apply unchanged; the only
 * behavioral difference is the write format.
 *
 * Reads the package-manager version from the `packageManager` and
 * `devEngines.packageManager` fields (favoring devEngines) and upgrades it
 * according to the `upgrade-package-manager` mode: "false" (skip), "true"/"auto" (latest
 * within the current major), or a semver range (may cross majors, and adds a
 * `packageManager` field when none exists). A `packageManager` or
 * `devEngines.packageManager` entry that names a *different* package manager
 * than the one being upgraded is not a reference for this run and is ignored.
 *
 * pnpm and npm are corepack-managed: corepack reads the `packageManager`
 * field and verifies its `+sha512.<hex>` hash, so the resolved version is
 * written directly into both fields as a pinned `version+sha512.<hex>`
 * string (derived from the npm registry integrity) — no `corepack use` is
 * invoked. The subsequent `runInstall` activates the new version via
 * corepack reading the updated fields. bun is NOT corepack-managed — it is
 * installed by its own toolchain and never consults `packageManager` — so it
 * is written as a bare `bun@<version>` with no hash suffix, and the integrity
 * fetch is skipped entirely (a wasted registry round-trip otherwise). No
 * range operator is written for corepack-managed pms because a hash-pinned
 * value is inherently exact.
 *
 * `upgrade()` always resolves to an outcome (never `null`) so a caller can
 * report *why* nothing happened — "disabled", "no reference", "nothing
 * satisfies the range" and "already current" are distinct outcomes, not one
 * silent no-op. This matters because `upgrade-package-manager` is a range
 * typed for one package manager (frequently copy-pasted from another repo)
 * while the workspace has been detected as a different one: a pnpm range in
 * a bun repo resolves against bun's release list and, correctly, satisfies
 * nothing — that must read as "no bun release satisfies the range", not
 * "bun is already up-to-date".
 *
 * @module services/package-manager-upgrade
 */

import { readFileSync } from "node:fs";
import type { NpmRegistryShape } from "@effected/npm";
import { CorepackIntegrityHash, NpmRegistry, PackageManagerPin } from "@effected/npm";
import type { PackageJsonFileShape } from "@effected/package-json";
import { PackageJsonFile } from "@effected/package-json";
import { Context, Effect, Layer, Option, Result } from "effect";

import { FileSystemError } from "../errors/errors.js";
import { resolveLatestSatisfying } from "../utils/semver.js";
import type { SupportedPm } from "./package-manager.js";

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Package managers corepack manages. Corepack reads the `packageManager`
 * field and verifies the `+sha512.<hex>` hash; bun is installed by its own
 * toolchain and never consults it, so a hash there is noise.
 */
const COREPACK_MANAGED: ReadonlySet<SupportedPm> = new Set(["pnpm", "npm"]);

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

/** Where the reference version (if any) was read from. */
export type PackageManagerReferenceSource = "devEngines" | "packageManager" | null;

/**
 * Why an upgrade produced no write.
 *
 * The discriminant a caller dispatches on to decide how loudly to report the
 * skip. `reason` is prose for humans; `kind` is the machine-readable fact.
 *
 * - `disabled` — `upgrade-package-manager: false`. Benign.
 * - `no-reference` — auto mode with no `packageManager` /
 *   `devEngines.packageManager` entry for this package manager to anchor on.
 * - `unsatisfiable` — the range resolves to nothing in this package manager's
 *   release list. Almost always a range typed for a *different* package
 *   manager (a pnpm `^11.0.0` in a bun repo). NOT benign: the caller warns.
 * - `already-current` — the reference is already the newest version the range
 *   admits. Benign.
 * - `error` — the read/write failed. Reserved for callers that fold a caught
 *   failure into an outcome rather than propagating it.
 */
export type PackageManagerSkipKind = "disabled" | "no-reference" | "unsatisfiable" | "already-current" | "error";

/** The upgrade was applied: the resolved version differs from the reference and was written. */
export interface PackageManagerUpgradeApplied {
	readonly applied: true;
	readonly pm: SupportedPm;
	readonly reference: string | null;
	readonly referenceSource: PackageManagerReferenceSource;
	readonly targetRange: string;
	readonly from: string | null;
	readonly to: string;
	readonly packageManagerUpdated: boolean;
	readonly devEnginesUpdated: boolean;
	readonly added: boolean;
}

/** The upgrade did not run, or ran and had nothing to write — `kind`/`reason` say why. */
export interface PackageManagerUpgradeSkipped {
	readonly applied: false;
	readonly pm: SupportedPm;
	readonly reference: string | null;
	readonly referenceSource: PackageManagerReferenceSource;
	readonly targetRange: string | null;
	/** Machine-readable cause. Callers dispatch on this, never on `reason`. */
	readonly kind: PackageManagerSkipKind;
	readonly reason: string;
}

export type PackageManagerUpgradeOutcome = PackageManagerUpgradeApplied | PackageManagerUpgradeSkipped;

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class PackageManagerUpgrade extends Context.Service<
	PackageManagerUpgrade,
	{
		readonly upgrade: (
			mode: string,
			pm: SupportedPm,
			workspaceRoot: string,
		) => Effect.Effect<PackageManagerUpgradeOutcome, FileSystemError>;
	}
>()("PackageManagerUpgrade") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const registry = yield* NpmRegistry;
			// Resolved in the layer so `upgrade`'s requirement channel stays `never`.
			const packageJsonFile = yield* PackageJsonFile;
			return {
				upgrade: (mode, pm, workspaceRoot) =>
					upgradePackageManagerImpl(registry, mode, pm, workspaceRoot, packageJsonFile),
			};
		}),
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

const fsReadError = (path: string, e: unknown) => new FileSystemError({ operation: "read", path, reason: String(e) });

const fsWriteError = (path: string, e: unknown) => new FileSystemError({ operation: "write", path, reason: String(e) });

const skip = (
	pm: SupportedPm,
	reference: string | null,
	referenceSource: PackageManagerReferenceSource,
	targetRange: string | null,
	kind: PackageManagerSkipKind,
	reason: string,
): PackageManagerUpgradeSkipped => ({ applied: false, pm, reference, referenceSource, targetRange, kind, reason });

/**
 * The exact version a package-manager reference names, or `null` when the
 * field is absent, unparseable, or names a *different* manager than the one
 * being upgraded (e.g. `packageManager: "npm@10.0.0"` while upgrading bun) —
 * all of which mean the same thing here: no reference for this run.
 *
 * `bare` is how the two fields differ. `packageManager` carries the whole
 * corepack pin (`` `${pm}@<version>[+<integrity>]` ``); `devEngines.packageManager.version`
 * carries only the version tail, so the manager name is prepended to give the
 * one grammar the whole pin it parses.
 *
 * **The grammar is `@effected/npm`'s `PackageManagerPin`, not a local regex.**
 * The predecessor tested `/^\d+\.\d+\.\d+/` against the tail — a *prefix* match
 * — and returned the whole trailing string, so `pnpm@11.12.0garbage` became a
 * reference and the synthesized `^11.12.0garbage` range then reported
 * `unsatisfiable`, which is this service's diagnosis for a range typed for a
 * *different* package manager. A malformed integrity tail was likewise split off
 * and discarded in silence. It also returned `hasCaret` and `hasSha` alongside
 * the version, neither of which had a reader anywhere: the same
 * declared-never-consumed shape that deleted four error classes and the pnpm
 * version helpers.
 *
 * **A leading range operator is still stripped, deliberately, and only for
 * `devEngines`.** A range is illegal in a corepack pin — the pin grammar
 * rejects it, and so does corepack — but `devEngines.packageManager.version` is
 * specified to accept one, and repos write `^11.0.0` there. Handing that
 * straight to the pin grammar would report "no reference" and silently stop
 * upgrading a manager the repo plainly declares. The operator is dropped rather
 * than resolved because the reference is only ever used as the anchor a target
 * range is synthesized from.
 */
const referenceVersion = (raw: string, pm: SupportedPm, bare = false): string | null => {
	const trimmed = raw.trim();
	if (trimmed === "") return null;

	const spec = bare ? `${pm}@${trimmed.replace(/^[\^~]/, "")}` : trimmed;
	const parsed = PackageManagerPin.parseResult(spec);
	if (Result.isFailure(parsed)) return null;
	// A pin naming another manager is not this run's reference. The pin grammar
	// admits all four kit-supported names, so the check is here rather than
	// implied by parsing.
	if (parsed.success.name !== pm) return null;

	return parsed.success.version.toString();
};

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Core upgrade implementation that accepts a runner directly.
 *
 * `mode` is the parsed `upgrade-package-manager` value: "false" (skip), "true"/"auto"
 * (latest within the current major, favoring the devEngines version), or a
 * semver range string (may cross majors; adds a packageManager field when no
 * field for `pm` exists).
 *
 * The resolved version is written directly into `packageManager` and
 * `devEngines.packageManager.version`. `corepack use` is NOT invoked — for
 * corepack-managed pms, the subsequent `pnpm install` (or npm equivalent)
 * activates the new version via corepack reading the updated fields.
 */
const upgradePackageManagerImpl = (
	registry: NpmRegistryShape,
	mode: string,
	pm: SupportedPm,
	workspaceRoot: string,
	packageJsonFile: PackageJsonFileShape,
): Effect.Effect<PackageManagerUpgradeOutcome, FileSystemError> =>
	Effect.gen(function* () {
		if (mode === "false") {
			return skip(
				pm,
				null,
				null,
				null,
				"disabled",
				"package manager upgrade disabled (upgrade-package-manager: false)",
			);
		}

		const packageJsonPath = `${workspaceRoot}/package.json`;

		const packageJsonRaw = yield* Effect.try({
			try: () => readFileSync(packageJsonPath, "utf-8"),
			catch: (e) => fsReadError(packageJsonPath, e),
		});
		const packageJson = yield* Effect.try({
			try: () => JSON.parse(packageJsonRaw) as Record<string, unknown>,
			catch: (e) => fsReadError(packageJsonPath, `Invalid JSON: ${e}`),
		});

		// Detect package-manager version fields, ignoring any that name a
		// different package manager than `pm`.
		const packageManagerRaw = typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
		const pmVersion = packageManagerRaw ? referenceVersion(packageManagerRaw, pm) : null;

		const devEngines = packageJson.devEngines as { packageManager?: { name?: string; version?: string } } | undefined;
		const devEnginesPm = devEngines?.packageManager;
		const devEnginesVersionRaw =
			devEnginesPm?.name === pm && typeof devEnginesPm.version === "string" ? devEnginesPm.version : null;
		const deVersion = devEnginesVersionRaw ? referenceVersion(devEnginesVersionRaw, pm, true) : null;

		// Reference version favors devEngines, then packageManager.
		const reference = deVersion ?? pmVersion ?? null;
		const referenceSource: PackageManagerReferenceSource = deVersion
			? "devEngines"
			: pmVersion
				? "packageManager"
				: null;
		const isAuto = mode === "true" || mode === "auto";

		let targetRange: string;
		if (isAuto) {
			if (reference === null) {
				const reason = `no ${pm} reference found (packageManager or devEngines.packageManager)`;
				yield* Effect.logWarning(`upgrade-package-manager: true/auto requested but ${reason}, skipping`);
				return skip(pm, null, null, null, "no-reference", reason);
			}
			targetRange = `^${reference}`;
		} else {
			targetRange = mode;
		}

		// Query available versions via NpmRegistry, which redirects npm's cache to
		// a runner-writable directory — a raw `npm view` here hits the partially
		// root-owned ~/.npm on GitHub's macOS runners and dies EACCES.
		const allVersions = yield* registry
			.versions(pm)
			.pipe(Effect.mapError((e) => fsReadError("npm registry", `Failed to query ${pm} versions: ${e.message}`)));

		const resolved = yield* resolveLatestSatisfying(allVersions, targetRange);
		if (!resolved) {
			// `unsatisfiable` is the acceptance signal, not a benign no-op: the
			// overwhelmingly common cause is an upgrade-package-manager range typed
			// for a *different* package manager than the workspace actually uses
			// (e.g. a pnpm "^11.0.0" range in a bun repo, copy-pasted from another
			// repo's workflow). Nothing satisfies it. Reporting is the caller's job
			// — `program.ts` promotes this kind to a warning so it cannot read like
			// "disabled" or "already up-to-date" — so no log is emitted here.
			return skip(
				pm,
				reference,
				referenceSource,
				targetRange,
				"unsatisfiable",
				`no ${pm} release satisfies "${targetRange}"`,
			);
		}
		if (reference !== null && resolved === reference) {
			const reason = `${pm} ${reference} already satisfies "${targetRange}"`;
			yield* Effect.logInfo(`${pm} ${reference} is already the latest for "${targetRange}"`);
			return skip(pm, reference, referenceSource, targetRange, "already-current", reason);
		}

		// Derive the corepack-canonical packageManager hash from the npm registry
		// integrity for the resolved version — corepack-managed pms only. bun is
		// not corepack-managed and never reads this field, so a hash there is
		// noise and the integrity fetch would be a wasted registry round-trip.
		const isCorepackManaged = COREPACK_MANAGED.has(pm);
		let hash: string | null = null;
		if (isCorepackManaged) {
			const integrity = yield* registry.version(pm, resolved).pipe(
				Effect.map((info) => (Option.isSome(info) ? (info.value.integrity ?? "") : "")),
				Effect.catch(() => Effect.succeed("")),
			);
			// `CorepackIntegrityHash.fromSri`, not a local converter. The SRI →
			// corepack conversion this module used to hand-roll is the kit's now
			// (issue #290; effected#281 cites this repo as the consumer evidence),
			// and the kit is STRICTER in the direction that matters: the local
			// version base64-decoded whatever followed `sha512-` and emitted the
			// hex, so non-canonical base64 or a wrong-length digest became a pin
			// that looked well-formed and that corepack rejects at install time, in
			// the consumer's repository, after this action has reported success.
			// Those now fail typed here and degrade to the bare-version write that
			// an absent integrity already took.
			hash = yield* CorepackIntegrityHash.fromSri(integrity).pipe(Effect.catch(() => Effect.succeed(null)));
			if (hash === null) {
				yield* Effect.logWarning(`Could not derive integrity hash for ${pm}@${resolved}; writing version without hash`);
			}
		}
		const pinnedSuffix = isCorepackManaged && hash !== null ? `+${hash}` : "";
		const packageManagerSpec = `${pm}@${resolved}${pinnedSuffix}`;
		const devEnginesSpec = `${resolved}${pinnedSuffix}`;

		// Write fields directly. Write packageManager when one exists for `pm`, or
		// (range mode only — auto returns early on a null reference) when NO
		// field for `pm` exists at all, creating it.
		const hasPackageManager = pmVersion !== null;
		const hasDevEngines = deVersion !== null;
		const shouldWritePackageManager = hasPackageManager || (!hasPackageManager && !hasDevEngines);

		// Collected as surgical field edits rather than applied to the parsed tree:
		// the write goes through `PackageJsonFile.modify`, which rewrites only the
		// edited spans and leaves key order, indentation and line endings exactly as
		// the consumer had them. This manifest is committed to someone else's
		// repository, so a whole-file re-serialize would make the diff unreviewable.
		const edits: Array<{ readonly path: ReadonlyArray<string | number>; readonly value: unknown }> = [];

		let packageManagerUpdated = false;
		let added = false;
		if (shouldWritePackageManager) {
			edits.push({ path: ["packageManager"], value: packageManagerSpec });
			packageManagerUpdated = true;
			added = !hasPackageManager;
		}

		let devEnginesUpdated = false;
		if (hasDevEngines) {
			edits.push({ path: ["devEngines", "packageManager", "version"], value: devEnginesSpec });
			devEnginesUpdated = true;
		}

		yield* packageJsonFile
			.modify(
				packageJsonPath,
				edits.map((e) => ({ path: [...e.path], value: e.value })),
			)
			.pipe(Effect.mapError((e) => fsWriteError(packageJsonPath, e)));

		yield* Effect.logInfo(`Updated ${pm}: ${reference ?? "added"} -> ${resolved}`);
		return {
			applied: true,
			pm,
			reference,
			referenceSource,
			targetRange,
			from: reference,
			to: resolved,
			packageManagerUpdated,
			devEnginesUpdated,
			added,
		};
	});
