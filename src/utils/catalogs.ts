import type { CatalogDelta } from "../schema/domain.js";

/**
 * Catalogs keyed by catalog name, each mapping a dependency to a version range.
 *
 * The `"default"` key is the default catalog: it lives in the manifest's
 * top-level `catalog` field, while every other key lives under the top-level
 * `catalogs` field. Both sit beside `workspaces` — they are not nested in it.
 */
export type CatalogMap = Record<string, Record<string, string>>;

/**
 * Coerce a `Map` or plain object into a plain record, or `null` if it is neither.
 */
const asRecord = (value: unknown): Record<string, unknown> | null => {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
};

/**
 * Normalize a config dependency's `catalogs` export into a {@link CatalogMap}.
 *
 * The export is read out of a third-party module we import at runtime, and a
 * bundler may emit either a `Map` or a plain object at each of the two levels —
 * a `Map` of plain objects is a real shape, not a hypothetical — so both are
 * accepted independently.
 *
 * A non-string range makes the whole shape non-conforming rather than dropping
 * that one entry: a plugin shipping a malformed catalog is broken, and
 * half-merging it would write a corrupt manifest. `null` is the caller's signal
 * to warn and skip that dependency.
 */
export const normalizeCatalogs = (value: unknown): CatalogMap | null => {
	const outer = asRecord(value);
	if (outer === null) {
		return null;
	}

	const result: CatalogMap = {};

	for (const [name, rawCatalog] of Object.entries(outer)) {
		const inner = asRecord(rawCatalog);
		if (inner === null) {
			return null;
		}

		const catalog: Record<string, string> = {};
		for (const [dependency, range] of Object.entries(inner)) {
			if (typeof range !== "string") {
				return null;
			}
			catalog[dependency] = range;
		}
		result[name] = catalog;
	}

	return result;
};

/**
 * Merge a config dependency's catalogs into the manifest, three-way.
 *
 * pnpm merges a config dependency's catalogs in memory at install time and never
 * rewrites the manifest. In a bun repo there is no such hook, so the merged
 * catalogs are written to disk — and a later run cannot then tell a deliberate
 * user override from an entry the action itself wrote. Diffing against `base`
 * (the catalogs of the version that was previously installed) separates them:
 *
 * - a key the disk still agrees with `base` on is ours, so it takes `next`'s
 *   value, and is deleted when `next` drops it;
 * - a key whose disk value diverges from `base` is the user's, and survives —
 *   even if upstream dropped it;
 * - a key absent from the disk is added.
 *
 * Only catalog names present in `base` or `next` are considered. A catalog name
 * no config dependency ships belongs to the consumer and is never touched.
 *
 * A `"kept"` delta means exactly one thing: a user override or user addition
 * survived the merge. An entry that is ours and simply did not move in this
 * release is not news — it produces no delta at all, rather than a `"kept"`
 * entry that would be indistinguishable from a real override.
 *
 * @param base - Catalogs shipped by the previously installed version.
 * @param disk - Catalogs currently in the manifest.
 * @param next - Catalogs shipped by the version being installed.
 */
export const threeWayMergeCatalogs = (
	base: CatalogMap,
	disk: CatalogMap,
	next: CatalogMap,
): { merged: CatalogMap; deltas: ReadonlyArray<CatalogDelta> } => {
	const merged: CatalogMap = structuredClone(disk);
	const deltas: Array<CatalogDelta> = [];

	const managedNames = new Set([...Object.keys(base), ...Object.keys(next)]);

	for (const catalog of managedNames) {
		const baseEntries = base[catalog] ?? {};
		const diskEntries = disk[catalog] ?? {};
		const nextEntries = next[catalog] ?? {};

		const entries: Record<string, string> = { ...diskEntries };
		const keys = new Set([...Object.keys(baseEntries), ...Object.keys(diskEntries), ...Object.keys(nextEntries)]);

		for (const dependency of keys) {
			const previous = diskEntries[dependency];
			const managed = baseEntries[dependency];
			const incoming = nextEntries[dependency];

			// Absent from the manifest: adopt whatever the new version ships.
			if (previous === undefined) {
				if (incoming !== undefined) {
					entries[dependency] = incoming;
					deltas.push({ catalog, dependency, from: null, to: incoming, action: "added" });
				}
				continue;
			}

			// Diverged from what the previous version shipped: the user's, kept as-is.
			if (previous !== managed) {
				deltas.push({ catalog, dependency, from: previous, to: previous, action: "kept" });
				continue;
			}

			// Ours. Follow the new version, including its removals.
			if (incoming === undefined) {
				delete entries[dependency];
				deltas.push({ catalog, dependency, from: previous, to: null, action: "removed" });
				continue;
			}

			entries[dependency] = incoming;
			if (incoming !== previous) {
				deltas.push({ catalog, dependency, from: previous, to: incoming, action: "updated" });
			}
		}

		merged[catalog] = entries;
	}

	return { merged, deltas };
};

/**
 * The manifest key a catalog map lives under, and the key it is anchored after.
 *
 * bun reads catalogs from the **top level** of the manifest: `catalog` (the
 * default catalog) and `catalogs` (the named ones) sit as siblings of
 * `workspaces`, which stays whatever it already was — usually the array form.
 * bun also tolerates the same two keys nested inside an object-form
 * `workspaces`, so that shape is still *read* (a repo may be written that way,
 * and an earlier build of this action wrote it), but it is never *written*:
 * writing promotes to the canonical top-level form and strips the nested copy.
 */
const CATALOG_ANCHOR = "workspaces";

/**
 * Set (or delete) a manifest key, inserting a brand-new key straight after
 * `after` rather than appending it to the end of the object.
 *
 * `JSON.stringify` emits keys in insertion order, so a plain assignment would
 * park a newly created `catalogs` block at the bottom of package.json, far from
 * the `workspaces` field it belongs with. Rebuilding the object in place keeps
 * the manifest readable and the diff tight.
 */
const upsertAfter = (
	obj: Record<string, unknown>,
	key: string,
	value: Record<string, unknown> | undefined,
	after: string,
): void => {
	if (value === undefined) {
		delete obj[key];
		return;
	}
	// Already present, or nothing to anchor to: assign in place.
	if (key in obj || !(after in obj)) {
		obj[key] = value;
		return;
	}

	const entries = Object.entries(obj);
	for (const existing of Object.keys(obj)) {
		delete obj[existing];
	}
	for (const [k, v] of entries) {
		obj[k] = v;
		if (k === after) {
			obj[key] = value;
		}
	}
};

/** Fold one manifest section's `catalog` / `catalogs` fields into `result`. */
const collectCatalogs = (source: Record<string, unknown>, result: CatalogMap): void => {
	const normalizedDefault = normalizeCatalogs({ default: source.catalog ?? {} });
	if (normalizedDefault?.default && Object.keys(normalizedDefault.default).length > 0) {
		result.default = { ...(result.default ?? {}), ...normalizedDefault.default };
	}

	const named = normalizeCatalogs(source.catalogs ?? {});
	if (named !== null) {
		for (const [name, entries] of Object.entries(named)) {
			result[name] = { ...(result[name] ?? {}), ...entries };
		}
	}
};

/**
 * Read the catalogs out of a root manifest.
 *
 * `catalog` is surfaced under the `"default"` key; every entry of `catalogs`
 * keeps its own name. The canonical top-level location is read last so that on
 * the (pathological) manifest carrying both shapes, it wins.
 */
export const readManifestCatalogs = (pkgJson: unknown): CatalogMap => {
	const manifest = asRecord(pkgJson);
	if (manifest === null) {
		return {};
	}

	const result: CatalogMap = {};

	// Legacy/tolerated: nested inside an object-form `workspaces`. `asRecord`
	// returns null for the array form, which is the common case.
	const nested = asRecord(manifest.workspaces);
	if (nested !== null) {
		collectCatalogs(nested, result);
	}

	collectCatalogs(manifest, result);

	return result;
};

/**
 * Write catalogs back into a root manifest, mutating it in place.
 *
 * Catalogs are written to the **top level** — `catalog` and `catalogs` as
 * siblings of `workspaces` — and `workspaces` itself is never rewritten: an
 * array stays an array. Any nested copy inside an object-form `workspaces` is
 * removed, migrating the manifest to the canonical shape. A catalog that has
 * become empty has its key removed rather than being left as an empty object.
 */
export const writeManifestCatalogs = (pkgJson: Record<string, unknown>, catalogs: CatalogMap): void => {
	// Migrate away from the nested form. `workspaces` keeps its own shape;
	// only the catalog keys are lifted out of it.
	if (!Array.isArray(pkgJson.workspaces)) {
		const nested = asRecord(pkgJson.workspaces);
		if (nested !== null) {
			delete nested.catalog;
			delete nested.catalogs;
		}
	}

	const { default: defaultCatalog, ...named } = catalogs;

	const populatedDefault = defaultCatalog && Object.keys(defaultCatalog).length > 0 ? { ...defaultCatalog } : undefined;
	const populatedNamed = Object.fromEntries(
		Object.entries(named).filter(([, entries]) => Object.keys(entries).length > 0),
	);

	upsertAfter(pkgJson, "catalog", populatedDefault, CATALOG_ANCHOR);
	// Anchor `catalogs` after `catalog` when there is one, so the two read in
	// their natural order; otherwise it goes straight after `workspaces`.
	upsertAfter(
		pkgJson,
		"catalogs",
		Object.keys(populatedNamed).length > 0 ? populatedNamed : undefined,
		"catalog" in pkgJson ? "catalog" : CATALOG_ANCHOR,
	);
};
