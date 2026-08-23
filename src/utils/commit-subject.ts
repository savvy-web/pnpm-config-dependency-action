import type { DependencyUpdateResult } from "../schema/domain.js";
import type { RuntimeName } from "./runtime.js";

/**
 * Build the conventional-commit subject line for a dependency-update run.
 *
 * Returns the full subject including the `chore(deps): ` prefix. The same
 * string is used for both the PR title (which becomes the squash-commit subject
 * on the default branch) and the branch commit subject, so a reader can tell
 * runs apart from the history alone instead of a uniform "Update Silk
 * Dependencies".
 *
 * Resolution is first-match-wins over the run's contents, partitioned into four
 * buckets — the package manager (pnpm/bun/npm), runtime engines (node/deno/bun), pnpm
 * config dependencies, and regular dependencies. A single change is named
 * outright; a single category is summarized; a mix is composed into an
 * `upgrade … , update …` shape. Regular dependencies are broken down by their
 * package.json section (dependencies / devDependencies / peerDependencies /
 * optionalDependencies), counting distinct names per section in
 * production-first order.
 *
 * The 100-character header budget (commitlint's `header-max-length`, via
 * `@commitlint/config-conventional`) is enforced by a progressive ladder: the
 * typed breakdown is tried first; if it overflows, the coarse phrasing is
 * tried; only then does the subject degrade to the safe generic fallback. The
 * coarse phrasing never mislabels: a batch containing non-`dependencies`
 * sections is lumped as "packages", not as "dependencies".
 */
export const buildUpdateSubject = (updates: ReadonlyArray<DependencyUpdateResult>): string => {
	const typed = `${PREFIX}${resolveSubject(updates, "typed")}`;
	if (typed.length <= HEADER_MAX) return typed;
	const coarse = `${PREFIX}${resolveSubject(updates, "coarse")}`;
	return coarse.length <= HEADER_MAX ? coarse : `${PREFIX}${FALLBACK}`;
};

/**
 * Strip a leading range operator (`^`, `~`, `>=`, …) and any `+build` suffix so
 * the subject shows a clean version — `^24.16.0` -> `24.16.0`,
 * `11.7.0+sha512.abc` -> `11.7.0`.
 */
const displayVersion = (raw: string): string => raw.replace(/^[\s^~>=<]+/, "").split("+")[0];

const PREFIX = "chore(deps): ";
const FALLBACK = "update dependencies";
// commitlint's enforced limit (header-max-length, @commitlint/config-conventional).
// The previous 72 was self-imposed git-log styling, and it forced the accurate
// typed breakdown to degrade into a coarse form that called devDependencies
// "dependencies" on the most common run shape.
const HEADER_MAX = 100;

/** How the regular-deps bucket is phrased: per-section nouns or lumped. */
type Detail = "typed" | "coarse";

/** Production-first display order for the regular-dep sections. */
const DEP_TYPE_ORDER = ["dependency", "devDependency", "peerDependency", "optionalDependency"] as const;

type DepType = (typeof DEP_TYPE_ORDER)[number];

const DEP_TYPES = new Set<DependencyUpdateResult["type"]>(DEP_TYPE_ORDER);

/** package.json field-name nouns: `1 devDependency`, `4 devDependencies`. */
const depTypeNoun = (type: DepType, n: number): string => (n === 1 ? type : `${type.slice(0, -1)}ies`);

/** Distinct dependency names per section, in production-first order. */
const countByType = (deps: ReadonlyArray<DependencyUpdateResult>): ReadonlyArray<{ type: DepType; count: number }> =>
	DEP_TYPE_ORDER.map((type) => ({
		type,
		count: distinct(deps.filter((u) => u.type === type).map((u) => u.dependency)).length,
	})).filter(({ count }) => count > 0);

/** Canonical display order + casing for runtime engines. */
const RUNTIME_ORDER: ReadonlyArray<RuntimeName> = ["node", "deno", "bun"];
const RUNTIME_LABEL: Record<RuntimeName, string> = { node: "Node", deno: "Deno", bun: "Bun" };

const resolveSubject = (updates: ReadonlyArray<DependencyUpdateResult>, detail: Detail): string => {
	const pm = updates.find((u) => u.type === "packageManager") ?? null;
	const runtimes = RUNTIME_ORDER.filter((r) => updates.some((u) => u.type === "runtime" && u.dependency === r));
	const config = updates.filter((u) => u.type === "config");
	const deps = updates.filter((u) => DEP_TYPES.has(u.type));

	const configNames = distinct(config.map((u) => u.dependency));
	const depNames = distinct(deps.map((u) => u.dependency));
	const total = (pm ? 1 : 0) + runtimes.length + configNames.length + depNames.length;

	// Rule 10: nothing to describe.
	if (total === 0) return FALLBACK;

	// Rules 1-4: a single distinct change — name it.
	if (total === 1) {
		if (pm) return `upgrade ${pm.dependency} to ${displayVersion(pm.to)}`;
		if (runtimes.length === 1) {
			return `upgrade ${RUNTIME_LABEL[runtimes[0]]} to ${displayVersion(runtimeTo(updates, runtimes[0]))}`;
		}
		if (configNames.length === 1) return `bump ${configNames[0]} to ${displayVersion(config[0].to)}`;
		return `bump ${depNames[0]} to ${displayVersion(deps[0].to)}`;
	}

	const buckets =
		(pm ? 1 : 0) + (runtimes.length > 0 ? 1 : 0) + (configNames.length > 0 ? 1 : 0) + (depNames.length > 0 ? 1 : 0);

	// Rules 5-8: a single category with several items.
	if (buckets === 1) {
		if (runtimes.length > 0) return `upgrade ${joinAnd(runtimes.map((r) => RUNTIME_LABEL[r]))}`;
		if (configNames.length > 0) return `update ${configNames.length} config dependencies`;
		const typeCounts = countByType(deps);
		const sharedWorkspace = singleWorkspace(deps);
		if (sharedWorkspace) {
			// One section across one workspace gets the typed noun; a mixed batch
			// keeps the generic noun rather than enumerating inside the clause.
			const sectionNoun =
				detail === "typed" && typeCounts.length === 1 ? depTypeNoun(typeCounts[0].type, 2) : "dependencies";
			return `update ${sectionNoun} in ${sharedWorkspace}`;
		}
		if (detail === "typed") return depsPhrase(typeCounts);
		return `update ${depNames.length} ${coarseDepNoun(depNames.length, typeCounts)}`;
	}

	// Rule 9: mixed categories — compose. The ladder in buildUpdateSubject
	// degrades an over-budget composition to coarse, then to the default.
	return compose(pm, runtimes, configNames.length, deps, depNames.length, detail);
};

const compose = (
	pm: DependencyUpdateResult | null,
	runtimes: ReadonlyArray<RuntimeName>,
	configCount: number,
	deps: ReadonlyArray<DependencyUpdateResult>,
	depCount: number,
	detail: Detail,
): string => {
	const clauses: string[] = [];

	const upgradeTargets = [...(pm ? [pm.dependency] : []), ...runtimes.map((r) => RUNTIME_LABEL[r])];
	if (upgradeTargets.length > 0) clauses.push(`upgrade ${joinAnd(upgradeTargets)}`);

	const updateClause = updatePhrase(configCount, deps, depCount, detail);
	if (updateClause) clauses.push(updateClause);

	if (clauses.length === 1) return clauses[0];
	// Use a comma when a clause is already compound ("upgrade pnpm and Node"),
	// otherwise "and" reads more naturally ("upgrade pnpm and update 6 …").
	const separator = clauses.some((c) => c.includes(" and ")) ? ", " : " and ";
	return clauses.join(separator);
};

/**
 * The `update …` clause. Coarse detail lumps regular deps into one count;
 * typed detail enumerates per section ("update 1 config dependency and
 * 4 devDependencies"). When the regular deps are all plain `dependencies`, the
 * elliptical coarse form is already precise ("config" modifies the shared
 * noun), so typed detail keeps it. When they are NOT all plain, the coarse
 * lump noun is "packages" — calling a devDependency batch "dependencies" made
 * release-neutral runs read as release-triggering.
 */
const updatePhrase = (
	configCount: number,
	deps: ReadonlyArray<DependencyUpdateResult>,
	depCount: number,
	detail: Detail,
): string | null => {
	if (configCount === 0 && depCount === 0) return null;
	const typeCounts = countByType(deps);
	const onlyPlainDeps = typeCounts.length === 0 || (typeCounts.length === 1 && typeCounts[0].type === "dependency");
	if (detail === "typed" && !onlyPlainDeps) {
		const configItem = configCount > 0 ? [`${configCount} config ${noun(configCount)}`] : [];
		const typeItems = typeCounts.map(({ type, count }) => `${count} ${depTypeNoun(type, count)}`);
		return `update ${joinAnd([...configItem, ...typeItems])}`;
	}
	if (configCount > 0 && depCount > 0) {
		// The elliptical shared-noun form is only honest when the noun is right
		// for every regular dep; otherwise the config noun is spelled out and the
		// regular deps lump as "packages".
		return onlyPlainDeps
			? `update ${configCount} config and ${pluralize(depCount)}`
			: `update ${configCount} config ${noun(configCount)} and ${depCount} ${coarseDepNoun(depCount, typeCounts)}`;
	}
	if (configCount > 0) return `update ${configCount} config ${noun(configCount)}`;
	return `update ${depCount} ${coarseDepNoun(depCount, typeCounts)}`;
};

/** The honest lump noun for a coarse regular-deps count, pluralized. */
const coarseDepNoun = (count: number, typeCounts: ReadonlyArray<{ type: DepType; count: number }>): string =>
	typeCounts.length === 0 || (typeCounts.length === 1 && typeCounts[0].type === "dependency")
		? noun(count)
		: count === 1
			? "package"
			: "packages";

/** Typed single-category deps phrase: one section or a per-section enumeration. */
const depsPhrase = (typeCounts: ReadonlyArray<{ type: DepType; count: number }>): string =>
	`update ${joinAnd(typeCounts.map(({ type, count }) => `${count} ${depTypeNoun(type, count)}`))}`;

const pluralize = (n: number): string => `${n} ${noun(n)}`;
const noun = (n: number): string => (n === 1 ? "dependency" : "dependencies");

/** The single non-null workspace shared by every dep, or null otherwise. */
const singleWorkspace = (deps: ReadonlyArray<DependencyUpdateResult>): string | null => {
	const packages = distinct(deps.map((u) => u.package).filter((p): p is string => p !== null));
	const hasRoot = deps.some((u) => u.package === null);
	return !hasRoot && packages.length === 1 ? packages[0] : null;
};

const runtimeTo = (updates: ReadonlyArray<DependencyUpdateResult>, runtime: RuntimeName): string =>
	updates.find((u) => u.type === "runtime" && u.dependency === runtime)?.to ?? "";

const distinct = (values: ReadonlyArray<string>): string[] => [...new Set(values)];

const joinAnd = (items: ReadonlyArray<string>): string => {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};
