import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY, NpmRegistry, RegistryReadError } from "@effected/npm";
import { Effect, Layer, References } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededRegistry } from "../utils/fixtures.test.js";
import { PackageManagerUpgrade, PackageManagerUpgradeLive } from "./package-manager-upgrade.js";

// A real sha512 integrity so corepackHashFromIntegrity produces a hash.
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
			Effect.provide(PackageManagerUpgradeLive.pipe(Layer.provide(registryLayer))),
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
			Effect.provide(PackageManagerUpgradeLive.pipe(Layer.provide(registryLayer))),
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
});
