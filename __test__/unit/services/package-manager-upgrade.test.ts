import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { DEFAULT_REGISTRY, NpmRegistry, RegistryReadError } from "@effected/npm";
import { PackageJsonFile } from "@effected/package-json";
import { Effect, Layer, References } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageManagerUpgrade } from "../../../src/services/package-manager-upgrade.js";
import { seededRegistry } from "../../utils/fixtures.js";

// A canonical sha512 SRI hash — 88 base64 characters, so a 64-byte digest — which
// is what `CorepackIntegrityHash.fromSri` requires to convert. The malformed and
// wrong-length cases are exercised deliberately at the bottom of this file.
const FAKE_INTEGRITY =
	"sha512-Iv0lXkpG6NXcNu/khNeaNfpcI8KMnyOnmiB+BbwCw1t0csCZPzLf7EJ4zCuvD/yg1oyHquMXzBQHAzyGq+CnZw==";

let root: string;

const registry = seededRegistry({
	pnpm: { version: "11.13.0", versions: ["11.12.0", "11.13.0"], integrity: FAKE_INTEGRITY },
	bun: { version: "1.3.16", versions: ["1.3.14", "1.3.16"], integrity: FAKE_INTEGRITY },
	npm: { version: "10.9.0", versions: ["10.8.0", "10.9.0"], integrity: FAKE_INTEGRITY },
});

const runWith = <A>(
	fn: (service: Effect.Success<typeof PackageManagerUpgrade>) => Effect.Effect<A, unknown>,
	registryLayer: Layer.Layer<NpmRegistry> = registry,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* PackageManagerUpgrade;
			return yield* fn(service);
		}).pipe(
			Effect.provide(
				PackageManagerUpgrade.layer.pipe(
					Layer.provide(Layer.merge(registryLayer, PackageJsonFile.layer.pipe(Layer.provide(NodeServices.layer)))),
				),
			),
			Effect.provideService(References.MinimumLogLevel, "None"),
		) as Effect.Effect<A, never, never>,
	);

const run = <A>(fn: (service: Effect.Success<typeof PackageManagerUpgrade>) => Effect.Effect<A, unknown>) =>
	runWith(fn);

const runEither = <A, E>(
	fn: (service: Effect.Success<typeof PackageManagerUpgrade>) => Effect.Effect<A, E>,
	registryLayer: Layer.Layer<NpmRegistry> = registry,
) =>
	Effect.runPromise(
		Effect.result(
			Effect.gen(function* () {
				const service = yield* PackageManagerUpgrade;
				return yield* fn(service);
			}),
		).pipe(
			Effect.provide(
				PackageManagerUpgrade.layer.pipe(
					Layer.provide(Layer.merge(registryLayer, PackageJsonFile.layer.pipe(Layer.provide(NodeServices.layer)))),
				),
			),
			Effect.provideService(References.MinimumLogLevel, "None"),
		),
	);

const writePkg = (content: unknown) => writeFileSync(join(root, "package.json"), JSON.stringify(content, null, 2));
const readPkg = () => JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pm-upgrade-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("PackageManagerUpgrade", () => {
	it("writes bun as a bare version with no corepack hash", async () => {
		writePkg({
			name: "root",
			packageManager: "bun@1.3.14",
			devEngines: { packageManager: { name: "bun", version: "1.3.14" } },
		});

		const result = await run((s) => s.upgrade("auto", "bun", root));
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("1.3.16");
			expect(result.referenceSource).toBe("devEngines");
		}
		expect(pkg.packageManager).toBe("bun@1.3.16");
		expect(pkg.devEngines.packageManager.version).toBe("1.3.16");
		expect(pkg.packageManager).not.toContain("+sha512");
	});

	it("writes pnpm hash-pinned, as before", async () => {
		writePkg({
			name: "root",
			packageManager: "pnpm@11.12.0",
			devEngines: { packageManager: { name: "pnpm", version: "11.12.0" } },
		});

		const result = await run((s) => s.upgrade("auto", "pnpm", root));
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("11.13.0");
		}
		expect(pkg.packageManager).toMatch(/^pnpm@11\.13\.0\+sha512\.[0-9a-f]+$/);
		expect(pkg.devEngines.packageManager.version).toMatch(/^11\.13\.0\+sha512\.[0-9a-f]+$/);
	});

	it("reads the reference from devEngines in preference to packageManager", async () => {
		writePkg({
			name: "root",
			packageManager: "bun@1.3.14",
			devEngines: { packageManager: { name: "bun", version: "1.3.16" } },
		});

		const result = await run((s) => s.upgrade("auto", "bun", root));

		// Reference is 1.3.16 (devEngines), already the latest in ^1.3.16 -> no-op.
		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.reference).toBe("1.3.16");
			expect(result.referenceSource).toBe("devEngines");
			expect(result.reason).toContain("already satisfies");
		}
	});

	it("skips with a reason when the mode is false", async () => {
		writePkg({ name: "root", packageManager: "bun@1.3.14" });

		const result = await run((s) => s.upgrade("false", "bun", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.kind).toBe("disabled");
			expect(result.reason).toContain("disabled");
			expect(result.targetRange).toBeNull();
		}
	});

	it("ignores a devEngines entry naming a different package manager", async () => {
		writePkg({
			name: "root",
			packageManager: "bun@1.3.14",
			devEngines: { packageManager: { name: "pnpm", version: "11.12.0" } },
		});

		const result = await run((s) => s.upgrade("auto", "bun", root));

		// The pnpm devEngines entry is not a bun reference; fall back to packageManager.
		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBe("1.3.14");
			expect(result.to).toBe("1.3.16");
			expect(result.referenceSource).toBe("packageManager");
		}
	});

	// ──────────────────────────────────────────────────────────────────────
	// Additional coverage: npm (the second corepack-managed pm), the
	// packageManager-side name-mismatch branch, missing-field skip, explicit
	// range mode, indentation preservation, and the integrity-fetch skip for
	// non-corepack-managed pms.
	// ──────────────────────────────────────────────────────────────────────

	it("upgrades npm hash-pinned, same as pnpm (corepack-managed)", async () => {
		writePkg({
			name: "root",
			packageManager: "npm@10.8.0",
			devEngines: { packageManager: { name: "npm", version: "10.8.0" } },
		});

		const result = await run((s) => s.upgrade("auto", "npm", root));
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("10.9.0");
		}
		expect(pkg.packageManager).toMatch(/^npm@10\.9\.0\+sha512\.[0-9a-f]+$/);
		expect(pkg.devEngines.packageManager.version).toMatch(/^10\.9\.0\+sha512\.[0-9a-f]+$/);
	});

	it("ignores a packageManager field naming a different package manager and skips when no reference remains", async () => {
		writePkg({ name: "root", packageManager: "npm@10.8.0" });

		const result = await run((s) => s.upgrade("auto", "pnpm", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.reference).toBeNull();
			expect(result.referenceSource).toBeNull();
			expect(result.reason).toContain("no pnpm reference found");
		}
	});

	it("returns a no-reference skip when no package-manager fields exist at all", async () => {
		writePkg({ name: "root", version: "1.0.0" });

		const result = await run((s) => s.upgrade("true", "pnpm", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.reason).toContain("no pnpm reference found");
		}
	});

	it("updates devEngines only (no packageManager field) writing pinned form", async () => {
		writePkg({
			name: "root",
			devEngines: { packageManager: { name: "pnpm", version: "11.12.0" } },
		});

		const result = await run((s) => s.upgrade("^11", "pnpm", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBe("11.12.0");
			expect(result.to).toBe("11.13.0");
			expect(result.packageManagerUpdated).toBe(false);
			expect(result.devEnginesUpdated).toBe(true);
			expect(result.added).toBe(false);
		}

		const pkg = readPkg();
		expect(pkg.packageManager).toBeUndefined();
	});

	it("adds a packageManager field (added: true) when none exists and an explicit range is given", async () => {
		writePkg({ name: "root", version: "1.0.0" });

		const result = await run((s) => s.upgrade("^11", "pnpm", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBeNull();
			expect(result.to).toBe("11.13.0");
			expect(result.added).toBe(true);
			expect(result.packageManagerUpdated).toBe(true);
		}

		const pkg = readPkg();
		expect(pkg.packageManager).toMatch(/^pnpm@11\.13\.0\+sha512\.[0-9a-f]+$/);
	});

	it("adds a bare bun field (added: true, no hash) when none exists and an explicit range is given", async () => {
		writePkg({ name: "root", version: "1.0.0" });

		const result = await run((s) => s.upgrade("^1", "bun", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBeNull();
			expect(result.to).toBe("1.3.16");
			expect(result.added).toBe(true);
		}

		const pkg = readPkg();
		expect(pkg.packageManager).toBe("bun@1.3.16");
	});

	it("reports the range and 'none satisfying' reason when no version satisfies an explicit range", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		const result = await run((s) => s.upgrade("^99", "pnpm", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.reference).toBe("11.12.0");
			expect(result.referenceSource).toBe("packageManager");
			expect(result.targetRange).toBe("^99");
			expect(result.kind).toBe("unsatisfiable");
			expect(result.reason).toBe('no pnpm release satisfies "^99"');
		}
	});

	it("reports the classic pnpm-range-in-a-bun-repo case: nothing in bun's release list satisfies a pnpm range", async () => {
		writePkg({
			name: "root",
			devEngines: { packageManager: { name: "bun", version: "1.3.14" } },
		});

		const result = await run((s) => s.upgrade("^11.0.0", "bun", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.pm).toBe("bun");
			expect(result.reference).toBe("1.3.14");
			expect(result.referenceSource).toBe("devEngines");
			expect(result.targetRange).toBe("^11.0.0");
			// The discriminant program.ts dispatches on to promote this to a WARNING.
			// It must NOT be confusable with the benign "already-current" skip below.
			expect(result.kind).toBe("unsatisfiable");
			expect(result.reason).toBe('no bun release satisfies "^11.0.0"');
		}
	});

	it("returns an already-current skip when already on the latest for an explicit range", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.13.0" });

		const result = await run((s) => s.upgrade("11.13.0", "pnpm", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.kind).toBe("already-current");
			expect(result.reason).toBe('pnpm 11.13.0 already satisfies "11.13.0"');
		}
	});

	it("treats true and auto identically", async () => {
		writePkg({ name: "root", packageManager: "bun@1.3.14" });

		const result = await run((s) => s.upgrade("true", "bun", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBe("1.3.14");
			expect(result.to).toBe("1.3.16");
		}
	});

	it("detects tab indentation and preserves it", async () => {
		writeFileSync(
			join(root, "package.json"),
			`${JSON.stringify({ name: "root", packageManager: "pnpm@11.12.0" }, null, "\t")}\n`,
		);

		await run((s) => s.upgrade("true", "pnpm", root));

		const raw = readFileSync(join(root, "package.json"), "utf-8");
		expect(raw).toMatch(/^\t"/m);
	});

	it("detects space indentation and preserves it", async () => {
		writeFileSync(
			join(root, "package.json"),
			`${JSON.stringify({ name: "root", packageManager: "pnpm@11.12.0" }, null, 2)}\n`,
		);

		await run((s) => s.upgrade("true", "pnpm", root));

		const raw = readFileSync(join(root, "package.json"), "utf-8");
		expect(raw).toMatch(/^ {2}"/m);
		expect(raw).not.toMatch(/^\t"/m);
	});

	it("writes bare version (no hash) for a corepack-managed pm when integrity is unavailable", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		const noIntegrityRegistry = seededRegistry({
			pnpm: { version: "11.13.0", versions: ["11.12.0", "11.13.0"] },
		});

		const result = await runWith((s) => s.upgrade("true", "pnpm", root), noIntegrityRegistry);
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("11.13.0");
		}
		expect(pkg.packageManager).toBe("pnpm@11.13.0");
	});

	it("writes bare version (no hash) when the integrity query fails for a corepack-managed pm", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		const failingIntegrity = Layer.effect(
			NpmRegistry,
			Effect.gen(function* () {
				const base = yield* NpmRegistry;
				return {
					...base,
					version: (pkg: string) =>
						Effect.fail(new RegistryReadError({ kind: "transport", package: pkg, registry: DEFAULT_REGISTRY })),
				};
			}),
		).pipe(Layer.provide(registry));

		const result = await runWith((s) => s.upgrade("true", "pnpm", root), failingIntegrity);
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("11.13.0");
		}
		expect(pkg.packageManager).toBe("pnpm@11.13.0");
	});

	it("never queries the registry for a version of a non-corepack-managed pm (bun)", async () => {
		writePkg({ name: "root", packageManager: "bun@1.3.14" });

		let versionQueries = 0;
		const countingRegistry = Layer.effect(
			NpmRegistry,
			Effect.gen(function* () {
				const base = yield* NpmRegistry;
				return {
					...base,
					version: (pkg: string, version: string, target?: Parameters<typeof base.version>[2]) => {
						versionQueries++;
						return base.version(pkg, version, target);
					},
				};
			}),
		).pipe(Layer.provide(registry));

		const result = await runWith((s) => s.upgrade("true", "bun", root), countingRegistry);

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.to).toBe("1.3.16");
		}
		expect(versionQueries).toBe(0);
	});

	it("parses an existing hash-pinned packageManager reference", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0+sha512.deadbeef" });

		const result = await run((s) => s.upgrade("true", "pnpm", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBe("11.12.0");
			expect(result.to).toBe("11.13.0");
		}
	});

	it("parses an existing caret-prefixed devEngines reference", async () => {
		writePkg({
			name: "root",
			devEngines: { packageManager: { name: "pnpm", version: "^11.12.0" } },
		});

		const result = await run((s) => s.upgrade("true", "pnpm", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.from).toBe("11.12.0");
			expect(result.to).toBe("11.13.0");
		}
	});

	it("fails when package.json does not exist", async () => {
		const result = await runEither((s) => s.upgrade("true", "pnpm", root));

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure._tag).toBe("FileSystemError");
		}
	});

	it("fails when package.json has invalid JSON", async () => {
		writeFileSync(join(root, "package.json"), "{ not valid json");

		const result = await runEither((s) => s.upgrade("true", "pnpm", root));

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure._tag).toBe("FileSystemError");
		}
	});

	it("maps a registry versions-query failure to FileSystemError", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		// A FAILING query, not an empty registry: an empty one is a successful
		// "no such package" answer and takes the unsatisfiable path instead.
		const failingVersions = NpmRegistry.layerTest({
			versions: (pkg: string) =>
				Effect.fail(new RegistryReadError({ kind: "transport", package: pkg, registry: DEFAULT_REGISTRY })),
		});

		const result = await runEither((s) => s.upgrade("true", "pnpm", root), failingVersions);

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure._tag).toBe("FileSystemError");
		}
	});

	// ══════════════════════════════════════════════════════════════════════════
	// The @effected/npm adoption (issue #290)
	// ══════════════════════════════════════════════════════════════════════════

	// These three pin the behaviour that CHANGED when the local
	// `corepackHashFromIntegrity` and `parsePmVersion` were replaced by
	// `CorepackIntegrityHash.fromSri` and `PackageManagerPin`. All three would
	// have passed against the old helpers by writing something wrong rather than
	// by failing, which is why they assert on the file's contents.

	it("writes bare version rather than a bogus pin when the registry integrity is malformed", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		// Valid base64, valid `sha512-` prefix, but a 4-byte digest. The deleted
		// local converter base64-decoded whatever followed the prefix and emitted
		// the hex, so this produced `pnpm@11.13.0+sha512.deadbeef` — a pin that
		// looks well-formed, passes every assertion this suite used to make, and
		// is rejected by corepack at install time in the CONSUMER's repository,
		// after this action has already reported success.
		const shortDigestRegistry = seededRegistry({
			pnpm: { version: "11.13.0", versions: ["11.12.0", "11.13.0"], integrity: "sha512-3q2+7w==" },
		});

		const result = await runWith((s) => s.upgrade("true", "pnpm", root), shortDigestRegistry);
		const pkg = readPkg();

		expect(result.applied).toBe(true);
		expect(pkg.packageManager).toBe("pnpm@11.13.0");
		expect(pkg.packageManager).not.toContain("+");
	});

	it("writes bare version when the registry reports a non-sha512 integrity", async () => {
		writePkg({ name: "root", packageManager: "pnpm@11.12.0" });

		// corepack pins accept nothing weaker than sha512, so converting a sha256
		// SRI hash would mint a pin corepack refuses. Both the old helper and the
		// kit decline this one — it is here as the CONTROL for the case above,
		// which is the one that used to convert.
		const sha256Registry = seededRegistry({
			pnpm: {
				version: "11.13.0",
				versions: ["11.12.0", "11.13.0"],
				integrity: "sha256-Iv0lXkpG6NXcNu/khNeaNfpcI8KMnyOnmiB+BbwCw1s=",
			},
		});

		const result = await runWith((s) => s.upgrade("true", "pnpm", root), sha256Registry);

		expect(result.applied).toBe(true);
		expect(readPkg().packageManager).toBe("pnpm@11.13.0");
	});

	it("ignores a packageManager pin whose version is not exact semver", async () => {
		// The deleted parser tested `/^\d+\.\d+\.\d+/` against the tail, so it
		// matched the PREFIX and handed back the whole trailing string as the
		// reference — anchoring the synthesized `^<reference>` range on a version
		// that does not exist, and reporting the result as `unsatisfiable` (i.e.
		// "no pnpm release satisfies the range"), which is the diagnosis for a
		// range typed for the wrong package manager. The pin grammar rejects the
		// value outright, so `auto` correctly reports having nothing to anchor on.
		//
		// The input is deliberately `11.12.0garbage` and not a partial like
		// `11.12`: the old parser rejected partials too, so a partial would pass
		// against both implementations and prove nothing.
		writePkg({ name: "root", packageManager: "pnpm@11.12.0garbage" });

		const result = await run((s) => s.upgrade("auto", "pnpm", root));

		expect(result.applied).toBe(false);
		if (!result.applied) {
			expect(result.kind).toBe("no-reference");
		}
		expect(readPkg().packageManager).toBe("pnpm@11.12.0garbage");
	});

	it("still reads a RANGE in devEngines.packageManager.version, which the pin grammar alone rejects", async () => {
		// devEngines is specified to accept a range and repos write one; a corepack
		// pin is exact by definition and `PackageManagerPin` says so. Handing the
		// raw value to the pin grammar would report "no reference" and silently
		// stop upgrading a manager the repo plainly declares, so the leading
		// operator is stripped before parsing. This is the one place the two
		// fields' grammars genuinely differ.
		writePkg({
			name: "root",
			devEngines: { packageManager: { name: "pnpm", version: "^11.12.0", onFail: "ignore" } },
		});

		const result = await run((s) => s.upgrade("auto", "pnpm", root));

		expect(result.applied).toBe(true);
		if (result.applied) {
			expect(result.referenceSource).toBe("devEngines");
			expect(result.from).toBe("11.12.0");
			expect(result.to).toBe("11.13.0");
		}
	});
});
