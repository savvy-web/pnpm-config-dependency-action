/**
 * Tests for CatalogConfigDeps.
 *
 * The fetch path is exercised end to end: real gzipped tarballs on disk, a
 * `tar` extraction through the real platform spawner, and a real dynamic import
 * of the extracted entry module. Only the network (`HttpClient`), the registry
 * (`NpmRegistry`) and the lockfile (`LockfileReader`) are stubbed.
 *
 * @module services/catalog-config-deps.test
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { LockfileReadError, LockfileReader } from "@effected/workspaces";
import { Effect, Exit, Layer, Option, References } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogConfigDeps, CatalogConfigDepsLive } from "../../src/services/catalog-config-deps.js";
import { seededRegistry } from "../utils/fixtures.js";
import { makeTarball } from "./__fixtures__/tarball.js";

// Toggle for the final manifest write, so the FileSystemError path can be
// exercised without depending on filesystem permissions (which differ between
// a root container and a developer's machine). Defaults to passthrough; the
// fixture helpers in this file write through the same mocked module.
const fsFailures = { write: false };

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (fsFailures.write && String(args[0]).endsWith("package.json")) {
				throw new Error("EACCES: permission denied, write");
			}
			return actual.writeFileSync(...args);
		},
	};
});

const PKG = "@fixture/plugin";
/** Two config dependencies merging onto one manifest, in listed order. */
const FIRST = "@fixture/first";
const SECOND = "@fixture/second";

let root: string;
let work: string;
/** `<pkg>@<version>` -> built tarball path on disk. */
let tarballs: Map<string, string>;
/** Every tarball URL the HTTP stub was asked for, in order. */
let downloads: Array<string>;

/** A tarball URL that names the package and version it serves. */
const tarballUrl = (pkg: string, version: string) =>
	`https://registry.example/${encodeURIComponent(pkg)}/${version}.tgz`;

/**
 * Serve whichever tarball the requested URL names, 404 when that version has no
 * tarball built (a yanked or unpublished version).
 */
const httpStub = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) => {
		downloads.push(request.url);
		const [rawPkg, rawVersion] = request.url.split("/").slice(-2);
		const key = `${decodeURIComponent(rawPkg ?? "")}@${(rawVersion ?? "").replace(".tgz", "")}`;
		const path = tarballs.get(key);
		if (path === undefined) {
			return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
		}
		return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(readFileSync(path) as never)));
	}),
);

// The extraction shells out to a real `tar`, so this is the real platform
// spawner rather than a double.
const realRunner = NodeServices.layer;

/**
 * A registry with a per-version tarball URL.
 *
 * The kit's seed is keyed by `(registry, name, version)`, so the base and next
 * versions of one package serve two different tarballs — which is the whole
 * point of the three-way merge. The predecessor's double carried one tarball
 * per package regardless of the version asked for, which is why this file used
 * to hand-roll a `Layer.succeed(NpmRegistry, …)` here.
 */
const registry = (packages: Record<string, ReadonlyArray<string>>) =>
	seededRegistry(
		Object.fromEntries(
			Object.entries(packages).map(([pkg, versions]) => [
				pkg,
				{
					version: versions[versions.length - 1] ?? "0.0.0",
					versions,
					perVersion: Object.fromEntries(versions.map((v) => [v, { tarball: tarballUrl(pkg, v) }])),
				},
			]),
		),
	);

/**
 * The versions the lockfile says are installed — the merge bases, keyed by
 * package name. A name absent from the map has no lockfile entry.
 *
 * Keyed by name (rather than answering every lookup with one version) so a
 * lookup for the wrong package cannot be masked by a stub that would have
 * answered anything.
 */
const lockfileFor = (installed: Readonly<Record<string, string>>) =>
	Layer.succeed(LockfileReader, {
		readLockfile: () => Effect.die("not used"),
		resolvedVersion: (name: string) => {
			const version = installed[name];
			return Effect.succeed(
				version === undefined ? Option.none() : Option.some({ name, version, isWorkspace: false, dependencies: {} }),
			);
		},
		workspaceDependencies: () => Effect.succeed([]),
		checkIntegrity: () => Effect.die("not used"),
	} as never);

/** The single-package case: the merge base for {@link PKG}. `null` = no entry. */
const lockfileStub = (installed: string | null) => lockfileFor(installed === null ? {} : { [PKG]: installed });

/** A lockfile that cannot be read at all (corrupt, or absent for the detected PM). */
const failingLockfileStub = Layer.succeed(LockfileReader, {
	readLockfile: () => Effect.die("not used"),
	resolvedVersion: () =>
		Effect.fail(new LockfileReadError({ lockfilePath: "/nope/bun.lock", format: "bun", cause: "unreadable" })),
	workspaceDependencies: () => Effect.succeed([]),
	checkIntegrity: () => Effect.die("not used"),
} as never);

const layers = (packages: Record<string, ReadonlyArray<string>>, lockfile: Layer.Layer<LockfileReader>) =>
	CatalogConfigDepsLive.pipe(Layer.provide(Layer.mergeAll(registry(packages), lockfile, httpStub, realRunner)));

const runWith = (
	deps: ReadonlyArray<string>,
	packages: Record<string, ReadonlyArray<string>>,
	lockfile: Layer.Layer<LockfileReader>,
	workspaceRoot: string | undefined = root,
) =>
	Effect.gen(function* () {
		const service = yield* CatalogConfigDeps;
		return yield* service.update(deps, workspaceRoot);
	}).pipe(Effect.provide(layers(packages, lockfile)), Effect.provideService(References.MinimumLogLevel, "None"));

/** The common case: one package, a lockfile-installed base version. */
const run = (deps: ReadonlyArray<string>, versions: ReadonlyArray<string>, installed: string | null) =>
	Effect.runPromise(runWith(deps, { [PKG]: versions }, lockfileStub(installed)));

/**
 * Two config dependencies merging onto one manifest, in listed order.
 *
 * Each is already installed at the only version it resolves to, so base equals
 * next for both and each merges exactly the catalogs it ships onto whatever the
 * one before it left behind.
 */
const runPair = () =>
	Effect.runPromise(
		runWith(
			[FIRST, SECOND],
			{ [FIRST]: ["1.0.0"], [SECOND]: ["2.0.0"] },
			lockfileFor({ [FIRST]: "1.0.0", [SECOND]: "2.0.0" }),
		),
	);

const writePkg = (content: unknown, indent: number | string = 2) =>
	writeFileSync(join(root, "package.json"), `${JSON.stringify(content, null, indent)}\n`);
const readPkg = () => JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const readPkgRaw = () => readFileSync(join(root, "package.json"), "utf-8");

const catalogsSource = (entries: Record<string, Record<string, string>>) =>
	`export const catalogs = ${JSON.stringify(entries)};`;

/** Build a tarball for `pkg@version` and register it with the HTTP stub. */
const publish = (pkg: string, version: string, source: string) => {
	tarballs.set(`${pkg}@${version}`, makeTarball(work, `${pkg.replace(/[^a-z0-9]/gi, "-")}-${version}`, source));
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ccd-root-"));
	work = mkdtempSync(join(tmpdir(), "ccd-work-"));
	tarballs = new Map();
	downloads = [];
});

afterEach(() => {
	fsFailures.write = false;
	rmSync(root, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});

describe("CatalogConfigDeps", () => {
	it("returns an empty result when no config dependencies are listed", async () => {
		// No workspaceRoot argument: exercises the process.cwd() default too.
		const result = await Effect.runPromise(runWith([], {}, lockfileStub(null), undefined));

		expect(result).toEqual({ updates: [], deltas: [] });
	});

	it("bumps the dependency range and merges the new version's catalogs", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");
		const pkg = readPkg();

		expect(pkg.devDependencies[PKG]).toBe("^0.24.0");
		expect(pkg.catalogs.silk.effect).toBe("^3.21.4");
	});

	it("emits the update as type: config so the PR matches a pnpm run", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: {} }));
		publish(PKG, "0.24.0", catalogsSource({ silk: {} }));
		writePkg({ name: "root", workspaces: ["."], devDependencies: { [PKG]: "^0.23.0" } });

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(result.updates).toEqual([
			expect.objectContaining({ dependency: PKG, from: "^0.23.0", to: "^0.24.0", type: "config" }),
		]);
	});

	it("merges into the default catalog and finds the dependency in dependencies", async () => {
		publish(PKG, "1.0.0", catalogsSource({ default: { effect: "^3.21.0" } }));
		publish(PKG, "1.1.0", catalogsSource({ default: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalog: { effect: "^3.21.0" },
			dependencies: { [PKG]: "^1.0.0" },
		});

		const result = await run([PKG], ["1.0.0", "1.1.0"], "1.0.0");

		expect(readPkg().catalog.effect).toBe("^3.21.4");
		expect(result.updates).toEqual([expect.objectContaining({ dependency: PKG, to: "^1.1.0", type: "config" })]);
	});

	it("uses the lockfile-resolved version as the merge base", async () => {
		// Disk agrees with what 0.23.1 shipped, so it is ours to update.
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(readPkg().catalogs.silk.effect).toBe("^3.21.4");
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "effect", action: "updated" }));
	});

	it("preserves a user override in a managed catalog", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { typescript: "^7.0.2" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { typescript: "^7.1.0" } }));
		writePkg({
			name: "root",
			// The user pinned typescript exactly — it differs from what 0.23.1 shipped.
			workspaces: ["."],
			catalogs: { silk: { typescript: "7.0.2" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(readPkg().catalogs.silk.typescript).toBe("7.0.2");
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "typescript", action: "kept" }));
	});

	it("propagates an upstream removal", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { lodash: "^4.17.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: {} }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { lodash: "^4.17.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(readPkg().catalogs?.silk ?? {}).not.toHaveProperty("lodash");
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "lodash", action: "removed" }));
	});

	it("fetches once and writes nothing when the installed version is already the newest in range", async () => {
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.4" } },
			devDependencies: { [PKG]: "^0.24.0" },
		});
		const before = readPkgRaw();

		const result = await run([PKG], ["0.24.0"], "0.24.0");

		expect(result.updates).toEqual([]);
		expect(result.deltas).toEqual([]);
		// Base and next are the same version: fetched once, not twice.
		expect(downloads).toHaveLength(1);
		expect(readPkgRaw()).toBe(before);
	});

	it("warns and skips a dependency absent from the root manifest", async () => {
		writePkg({ name: "root", workspaces: ["."], devDependencies: {} });

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(result.updates).toEqual([]);
		expect(result.deltas).toEqual([]);
	});

	it("warns and skips a dependency pinned to a catalog: specifier", async () => {
		writePkg({ name: "root", workspaces: ["."], devDependencies: { [PKG]: "catalog:silk" } });

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(result.updates).toEqual([]);
		expect(downloads).toEqual([]);
	});

	it("warns and skips a dependency the registry does not know", async () => {
		writePkg({ name: "root", workspaces: ["."], devDependencies: { [PKG]: "^0.23.0" } });

		const result = await Effect.runPromise(runWith([PKG], {}, lockfileStub("0.23.1")));

		expect(result.updates).toEqual([]);
		expect(downloads).toEqual([]);
	});

	it("warns and skips when no published version satisfies the declared range", async () => {
		writePkg({ name: "root", workspaces: ["."], devDependencies: { [PKG]: "^9.0.0" } });

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(result.updates).toEqual([]);
		expect(downloads).toEqual([]);
	});

	it("warns and skips a dependency whose module has no catalogs export", async () => {
		publish(PKG, "0.23.1", `export const nope = 1;`);
		publish(PKG, "0.24.0", `export const nope = 1;`);
		writePkg({ name: "root", workspaces: ["."], devDependencies: { [PKG]: "^0.23.0" } });

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		// The range is not bumped either: a module we cannot read catalogs from is
		// skipped whole, so we never write a version whose catalogs we did not merge.
		expect(result.updates).toEqual([]);
		expect(readPkg().devDependencies[PKG]).toBe("^0.23.0");
	});

	it("degrades to plugin-wins when the base version cannot be fetched", async () => {
		// 0.23.1 was yanked — only the next version's tarball resolves.
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4", react: "^19.0.0", stable: "^1.0.0" } }));
		writePkg({
			name: "root",
			// `zod` (a local addition) survives — plugin-wins only overwrites keys it
			// defines — but the override on `effect` is lost: with no base we cannot
			// tell an override from a stale entry we wrote ourselves. `stable` already
			// matches what the new version ships, so it is not news.
			workspaces: ["."],
			catalogs: { silk: { effect: "3.20.0", zod: "^3.24.0", stable: "^1.0.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		const result = await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");
		const silk = readPkg().catalogs.silk;

		expect(silk.effect).toBe("^3.21.4");
		expect(silk.zod).toBe("^3.24.0");
		expect(silk.react).toBe("^19.0.0");
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "effect", action: "updated" }));
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "react", action: "added" }));
		expect(result.deltas.map((d) => d.dependency)).not.toContain("stable");
		expect(result.deltas.map((d) => d.dependency)).not.toContain("zod");
	});

	it("falls back to the highest version in the declared range when the lockfile has no entry", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		// No lockfile entry: the base falls back to the highest version satisfying
		// `^0.23.0` — 0.23.1, the same version an install would have put on disk.
		const result = await run([PKG], ["0.23.1", "0.24.0"], null);

		expect(readPkg().catalogs.silk.effect).toBe("^3.21.4");
		expect(result.deltas).toContainEqual(expect.objectContaining({ dependency: "effect", action: "updated" }));
	});

	it("falls back to the declared version itself when nothing satisfies the literal specifier", async () => {
		// Caret-on-zero widening lets `^0.23.0` roll into the first stable major, so
		// `next` resolves even though no 0.x version is published any more. The base
		// fallback has no such widening, so it degrades to the declared version —
		// which has no tarball, so the merge degrades to plugin-wins.
		publish(PKG, "1.0.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.20.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		// 0.23.0 is listed as published (with no tarball built, so the fetch 404s)
		// because the seeded registry only serves versions it actually knows —
		// unlike the hand-rolled stub this replaces, which fabricated a tarball URL
		// for any version asked for, including unpublished ones. `next` still
		// resolves to 1.0.0: the widened `>=0.23.0 <2.0.0` range prefers it.
		const result = await run([PKG], ["0.23.0", "1.0.0"], null);

		expect(readPkg().devDependencies[PKG]).toBe("^1.0.0");
		expect(readPkg().catalogs.silk.effect).toBe("^3.21.4");
		expect(downloads).toContain(tarballUrl(PKG, "0.23.0"));
		expect(result.updates).toHaveLength(1);
	});

	it("treats an unreadable lockfile as no entry", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});

		const result = await Effect.runPromise(runWith([PKG], { [PKG]: ["0.23.1", "0.24.0"] }, failingLockfileStub));

		expect(result.updates).toHaveLength(1);
		expect(readPkg().catalogs.silk.effect).toBe("^3.21.4");
	});

	it("merges multiple config dependencies in listed order, later wins", async () => {
		// Both plugins ship the `silk` catalog with a different `effect` range.
		// The one listed last must win.
		publish(FIRST, "1.0.0", catalogsSource({ silk: { effect: "^3.20.0" } }));
		publish(SECOND, "2.0.0", catalogsSource({ silk: { effect: "^3.99.0" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: {},
			devDependencies: { [FIRST]: "^1.0.0", [SECOND]: "^2.0.0" },
		});

		const result = await runPair();

		expect(readPkg().catalogs.silk.effect).toBe("^3.99.0");
		// Neither range moved (both already at their newest in range), so the merge
		// is the only change.
		expect(result.updates).toEqual([]);
		expect(result.deltas.map((d) => d.to)).toEqual(["^3.20.0", "^3.99.0"]);
	});

	it("keeps the entries of an earlier config dependency when a later one ships disjoint keys", async () => {
		// Same catalog, no key in common: the second plugin manages neither the
		// catalog nor the key the first contributed, so it must not delete it.
		publish(FIRST, "1.0.0", catalogsSource({ silk: { effect: "^3.20.0" } }));
		publish(SECOND, "2.0.0", catalogsSource({ silk: { zod: "^3.24.0" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: {},
			devDependencies: { [FIRST]: "^1.0.0", [SECOND]: "^2.0.0" },
		});

		await runPair();

		expect(readPkg().catalogs.silk).toEqual({ effect: "^3.20.0", zod: "^3.24.0" });
	});

	it("keeps the catalog of an earlier config dependency when a later one ships a different catalog", async () => {
		// The ordinary multi-plugin shape: each contributes its own catalog.
		publish(FIRST, "1.0.0", catalogsSource({ alpha: { effect: "^3.20.0" } }));
		publish(SECOND, "2.0.0", catalogsSource({ beta: { zod: "^3.24.0" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: {},
			devDependencies: { [FIRST]: "^1.0.0", [SECOND]: "^2.0.0" },
		});

		await runPair();

		expect(readPkg().catalogs).toEqual({
			alpha: { effect: "^3.20.0" },
			beta: { zod: "^3.24.0" },
		});
	});

	it("preserves a user override on a key both config dependencies ship", async () => {
		// The overlay that makes the later plugin win a conflicting key must not also
		// hand it the user's override on that key.
		publish(FIRST, "1.0.0", catalogsSource({ silk: { effect: "^3.20.0" } }));
		publish(SECOND, "2.0.0", catalogsSource({ silk: { effect: "^3.99.0" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "3.10.0" } },
			devDependencies: { [FIRST]: "^1.0.0", [SECOND]: "^2.0.0" },
		});
		const before = readPkgRaw();

		const result = await runPair();

		expect(readPkg().catalogs.silk.effect).toBe("3.10.0");
		// Every delta is a surviving override, and no range moved: nothing changed,
		// so the manifest is not rewritten either.
		expect(result.deltas.every((d) => d.action === "kept")).toBe(true);
		expect(result.updates).toEqual([]);
		expect(readPkgRaw()).toBe(before);
	});

	it("does not report a phantom kept delta for an entry the action itself owns", async () => {
		// FIRST contributes `lodash` to the shared `silk` catalog; SECOND ships a
		// disjoint key in the same catalog. By the time SECOND's own base/next
		// diff runs, disk already carries FIRST's write — which diverges from
		// SECOND's own base (it never shipped `lodash`) and would otherwise be
		// misread as a surviving user override. It must not be reported as
		// "kept": FIRST wrote it this run, not a person.
		publish(FIRST, "1.0.0", catalogsSource({ silk: { lodash: "^4.17.0" } }));
		publish(SECOND, "2.0.0", catalogsSource({ silk: { chalk: "^5.0.0" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: {},
			devDependencies: { [FIRST]: "^1.0.0", [SECOND]: "^2.0.0" },
		});

		const result = await runPair();

		expect(readPkg().catalogs.silk).toEqual({ lodash: "^4.17.0", chalk: "^5.0.0" });
		expect(result.deltas).not.toContainEqual(expect.objectContaining({ action: "kept" }));
		expect(result.deltas.map((d) => d.dependency).sort()).toEqual(["chalk", "lodash"]);
	});

	it("adds catalogs beside an array workspaces field without rewriting it", async () => {
		// The shape of a real bun repo (design-docs-plugin): `workspaces` is an
		// array and no catalogs exist yet. The first merge must leave `workspaces`
		// verbatim and write `catalogs` as a top-level sibling — not nest catalogs
		// inside `workspaces` and synthesize a `packages` key.
		publish(PKG, "0.23.0", catalogsSource({ silk: {} }));
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.4" }, silkPeers: { effect: "^3.21.0" } }));
		writePkg({
			name: "design-docs",
			private: true,
			type: "module",
			workspaces: ["."],
			scripts: { test: "bun test" },
			devDependencies: { [PKG]: "^0.23.0" },
			packageManager: "bun@1.3.14",
			trustedDependencies: ["@parcel/watcher"],
		});

		await run([PKG], ["0.23.0", "0.23.1"], "0.23.0");
		const pkg = readPkg();

		expect(pkg.workspaces).toEqual(["."]);
		expect(pkg.workspaces.packages).toBeUndefined();
		expect(pkg.catalogs).toEqual({ silk: { effect: "^3.21.4" }, silkPeers: { effect: "^3.21.0" } });
		// The new block lands beside `workspaces`, not appended after every other
		// field, and nothing else in the manifest is disturbed.
		expect(Object.keys(pkg)).toEqual([
			"name",
			"private",
			"type",
			"workspaces",
			"catalogs",
			"scripts",
			"devDependencies",
			"packageManager",
			"trustedDependencies",
		]);
		expect(pkg.trustedDependencies).toEqual(["@parcel/watcher"]);
	});

	it("writes package.json once, preserving indentation", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg(
			{
				name: "root",
				workspaces: ["."],
				catalogs: { silk: { effect: "^3.21.0" } },
				devDependencies: { [PKG]: "^0.23.0" },
			},
			"\t",
		);

		await run([PKG], ["0.23.1", "0.24.0"], "0.23.1");

		expect(readPkgRaw()).toContain('\n\t"name"');
		expect(readPkgRaw().endsWith("\n")).toBe(true);
	});

	it("fails with a FileSystemError when the root manifest is missing", async () => {
		const exit = await Effect.runPromiseExit(runWith([PKG], { [PKG]: ["1.0.0"] }, lockfileStub(null)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with a FileSystemError when the root manifest is not valid JSON", async () => {
		writeFileSync(join(root, "package.json"), "{ not json");

		const exit = await Effect.runPromiseExit(runWith([PKG], { [PKG]: ["1.0.0"] }, lockfileStub(null)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with a FileSystemError when the merged manifest cannot be written", async () => {
		publish(PKG, "0.23.1", catalogsSource({ silk: { effect: "^3.21.0" } }));
		publish(PKG, "0.24.0", catalogsSource({ silk: { effect: "^3.21.4" } }));
		writePkg({
			name: "root",
			workspaces: ["."],
			catalogs: { silk: { effect: "^3.21.0" } },
			devDependencies: { [PKG]: "^0.23.0" },
		});
		fsFailures.write = true;

		const exit = await Effect.runPromiseExit(runWith([PKG], { [PKG]: ["0.23.1", "0.24.0"] }, lockfileStub("0.23.1")));

		expect(Exit.isFailure(exit)).toBe(true);
	});
});
