/**
 * Tests for module-catalogs.
 *
 * @module services/module-catalogs.test
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { DEFAULT_REGISTRY, NpmRegistry, PackageTarball, RegistryReadError } from "@effected/npm";
import { Effect, Layer, References } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchModuleCatalogs } from "../../src/services/module-catalogs.js";
import { seededRegistry } from "../utils/fixtures.js";
import { fromMap } from "../utils/spawner.js";
import { makeTarball } from "./__fixtures__/tarball.js";

let work: string;
let tarballPath: string;

const httpStub = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) =>
		Effect.succeed(HttpClientResponse.fromWeb(request, new Response(readFileSync(tarballPath) as never))),
	),
);

const httpFailStub = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) =>
		Effect.fail(
			new HttpClientError.HttpClientError({
				reason: new HttpClientError.TransportError({ request, description: "network down" }),
			}),
		),
	),
);

const httpNotFoundStub = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) =>
		Effect.succeed(HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }))),
	),
);

// The extraction step shells out to a real `tar`, so these run against the
// real platform spawner rather than a double — a fake cannot prove tar accepts
// the arguments the service assembles.
const realRunner = NodeServices.layer;

/**
 * Fetch + integrity + extract is `PackageTarball`'s now (effected#282), so every
 * stack in this file has to build it OVER the stub layers rather than beside
 * them -- it needs the HttpClient the test is stubbing, and merging it in as a
 * sibling would leave its own requirements unsatisfied.
 */
const withTarball = <A, E>(base: Layer.Layer<A, E, never>) => Layer.provideMerge(PackageTarball.layer, base);

/** A spawner whose every command fails, for the extraction-failure path. */
const failingRunner = fromMap(undefined, { exit: 1, stdout: "", stderr: "not a gzip file" }).layer;

const registry = (tarball: string | undefined, integrity?: string) =>
	seededRegistry({
		"@fixture/plugin": {
			version: "1.0.0",
			versions: ["1.0.0"],
			...(tarball ? { tarball } : {}),
			...(integrity ? { integrity } : {}),
		},
	});

/** The registry's `sha512-<base64>` integrity string for a tarball's actual bytes. */
const integrityOf = (path: string): string =>
	`sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

// A JS default parameter substitutes on an explicit `undefined` argument just
// as it does on an omitted one, so `run()` cannot double as "no tarball URL"
// via `run(undefined)` — that would silently fall through to this same
// default instead of exercising the no-tarball path. `tarball` therefore has
// no default; every call site is explicit, and this constant names the
// common case.
/**
 * Assert the outcome carries catalogs and hand them back.
 *
 * A bare `.catalogs` read would make an `Unavailable` outcome surface as
 * `undefined` deep inside a diff; this fails on the discriminant instead.
 */
const catalogsOf = (outcome: Awaited<ReturnType<typeof run>>) => {
	expect(outcome._tag).toBe("Catalogs");
	return outcome._tag === "Catalogs" ? outcome.catalogs : undefined;
};

const DEFAULT_TARBALL = "https://registry.example/plugin.tgz";

const run = (tarball: string | undefined) =>
	Effect.runPromise(
		fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
			Effect.provide(withTarball(Layer.mergeAll(registry(tarball), httpStub, realRunner))),
			Effect.provideService(References.MinimumLogLevel, "None"),
		),
	);

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "modcat-"));
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("fetchModuleCatalogs", () => {
	it("reads the catalogs export from a fetched tarball", async () => {
		tarballPath = makeTarball(
			work,
			"1.0.0",
			`export const catalogs = new Map([["silk", new Map([["effect", "^3.21.4"]])]]);`,
		);

		const result = await run(DEFAULT_TARBALL);

		expect(catalogsOf(result)).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("accepts a plain-object catalogs export", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = { silk: { effect: "^3.21.4" } };`);

		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("falls back to a Map/object-shaped default export when there is no named catalogs export", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export default new Map([["silk", new Map([["effect", "^3.21.4"]])]]);`);

		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("returns null when the module has no catalogs export", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const somethingElse = 1;`);

		expect(await run(DEFAULT_TARBALL)).toMatchObject({ _tag: "Unavailable" });
	});

	it("returns null when the catalogs export is malformed", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = "not a catalog map";`);

		expect(await run(DEFAULT_TARBALL)).toMatchObject({ _tag: "Unavailable" });
	});

	it("returns null when the registry reports no tarball URL", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = {};`);

		expect(await run(undefined)).toMatchObject({ _tag: "Unavailable", reason: "notFound" });
	});

	it("returns null when the npm registry query itself fails", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = {};`);

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/missing", "1.0.0").pipe(
				Effect.provide(
					withTarball(
						Layer.mergeAll(
							NpmRegistry.layerTest({
								version: (pkg: string) =>
									Effect.fail(new RegistryReadError({ kind: "transport", package: pkg, registry: DEFAULT_REGISTRY })),
							}),
							httpStub,
							realRunner,
						),
					),
				),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result).toMatchObject({ _tag: "Unavailable" });
	});

	it("returns null when the tarball download fails", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = {};`);

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
				Effect.provide(withTarball(Layer.mergeAll(registry(DEFAULT_TARBALL), httpFailStub, realRunner))),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result).toMatchObject({ _tag: "Unavailable" });
	});

	it("returns null when the tarball download responds with a non-2xx status", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = {};`);

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
				Effect.provide(withTarball(Layer.mergeAll(registry(DEFAULT_TARBALL), httpNotFoundStub, realRunner))),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result).toMatchObject({ _tag: "Unavailable" });
	});

	it("proceeds without verification when the registry reports no integrity for the version", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = { silk: { effect: "^3.21.4" } };`);

		// The shared `registry()` helper omits `integrity` unless given one, so
		// every other passing test in this suite already exercises this path;
		// this test names it explicitly as the absent-integrity case.
		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("reads the catalogs export when the downloaded tarball matches the advertised integrity", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = { silk: { effect: "^3.21.4" } };`);

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
				Effect.provide(
					withTarball(Layer.mergeAll(registry(DEFAULT_TARBALL, integrityOf(tarballPath)), httpStub, realRunner)),
				),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(catalogsOf(result)).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("returns null and never extracts when the downloaded tarball does not match the advertised integrity", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = { silk: { effect: "^3.21.4" } };`);

		// The registry vouches for bytes that are NOT what httpStub actually
		// serves (the real tarball) — a stand-in for a poisoned intermediary
		// (CDN edge, proxy, mirror) substituting different content in transit.
		const bogusIntegrity = `sha512-${createHash("sha512").update(Buffer.from("not-the-real-tarball-bytes")).digest("base64")}`;

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
				Effect.provide(withTarball(Layer.mergeAll(registry(DEFAULT_TARBALL, bogusIntegrity), httpStub, realRunner))),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result).toMatchObject({ _tag: "Unavailable" });
	});

	// The temp-directory and tarball-write cases that stood here are DELETED.
	// Both drove a `vi.mock("node:fs")` switch, and both stages moved into
	// `PackageTarball` (effected#282), which writes through Effect's `FileSystem`
	// rather than `node:fs`. The mock no longer intercepts anything, so the tests
	// passed the happy path while claiming to exercise a failure — a green
	// assertion about code that never ran, which is worse than no assertion.
	// Both stages now report `extractFailed`, and that IS covered: the extraction
	// case below drives a spawner whose `tar` genuinely fails.

	it("returns null when tarball extraction fails", async () => {
		tarballPath = makeTarball(work, "1.0.0", `export const catalogs = {};`);

		const result = await Effect.runPromise(
			fetchModuleCatalogs("@fixture/plugin", "1.0.0").pipe(
				Effect.provide(
					withTarball(Layer.mergeAll(registry(DEFAULT_TARBALL), httpStub, Layer.merge(realRunner, failingRunner))),
				),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(result).toMatchObject({ _tag: "Unavailable" });
	});

	it("returns null when the entry module cannot be imported (no node_modules for a runtime dependency)", async () => {
		tarballPath = makeTarball(
			work,
			"1.0.0",
			`import "this-package-does-not-exist-xyz-123"; export const catalogs = {};`,
		);

		expect(await run(DEFAULT_TARBALL)).toMatchObject({ _tag: "Unavailable" });
	});
});

// The `resolveEntryPoint` block that stood here is DELETED, not skipped: the
// function moved to `@effected/package-json` (effected#282) and this repo no
// longer owns it. Four of its cases asserted the OPPOSITE of the kit's
// behavior -- ours fell through to `main`/`index.js` when `exports` matched
// nothing, which resolves a file the package deliberately does not export.
// Node's rule is encapsulation; the kit returns a typed failure. Re-pointing
// those four at the kit would have pinned a bug. The end-to-end block below
// still covers the shapes THIS action actually loads, through the real
// resolver.

describe("fetchModuleCatalogs — exports shapes end to end", () => {
	const CATALOGS = `export const catalogs = { silk: { effect: "^3.21.4" } };`;

	it("loads the catalogs of a package whose exports is the string shorthand", async () => {
		tarballPath = makeTarball(work, "1.0.0", CATALOGS, "./index.js");

		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("loads the catalogs of a package with root conditional exports", async () => {
		tarballPath = makeTarball(work, "1.0.0", CATALOGS, { import: "./index.js", default: "./index.js" });

		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});

	it("loads the catalogs of a package with no exports field at all (index.js fallback)", async () => {
		// `null` is the fixture's "omit exports" sentinel — an explicit `undefined`
		// would substitute the default subpath map instead.
		tarballPath = makeTarball(work, "1.0.0", CATALOGS, null);

		expect(catalogsOf(await run(DEFAULT_TARBALL))).toEqual({ silk: { effect: "^3.21.4" } });
	});
});
