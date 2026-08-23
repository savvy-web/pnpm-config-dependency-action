import { describe, expect, it } from "vitest";
import type { DependencyUpdateResult } from "../../../src/schema/domain.js";
import { buildUpdateSubject } from "../../../src/utils/commit-subject.js";

/** Concise factory for a DependencyUpdateResult. */
const mk = (
	dependency: string,
	type: DependencyUpdateResult["type"],
	to: string,
	pkg: string | null = null,
	from: string | null = "0.0.0",
): DependencyUpdateResult => ({ dependency, type, to, package: pkg, from });

const PREFIX = "chore(deps): ";

describe("buildUpdateSubject", () => {
	describe("fallback (rule 10)", () => {
		it("returns the default for an empty update list", () => {
			expect(buildUpdateSubject([])).toBe(`${PREFIX}update dependencies`);
		});
	});

	describe("single headline (rules 1-4)", () => {
		it("rule 1: only pnpm -> upgrade pnpm to <version>", () => {
			expect(buildUpdateSubject([mk("pnpm", "packageManager", "11.7.0")])).toBe(`${PREFIX}upgrade pnpm to 11.7.0`);
		});

		it("rule 2: only a runtime -> upgrade <Name> to <version> (capitalized)", () => {
			expect(buildUpdateSubject([mk("node", "runtime", "26.1.0")])).toBe(`${PREFIX}upgrade Node to 26.1.0`);
		});

		it("rule 3: only a single regular dep -> bump <name> to <version>", () => {
			expect(buildUpdateSubject([mk("effect", "dependency", "3.21.3", "@savvy-web/foo")])).toBe(
				`${PREFIX}bump effect to 3.21.3`,
			);
		});

		it("rule 4: only a single config dep -> bump <name> to <version>", () => {
			expect(buildUpdateSubject([mk("typescript", "config", "5.9.2")])).toBe(`${PREFIX}bump typescript to 5.9.2`);
		});

		it("collapses a dep declared in two sections (same name) to one headline", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/foo"),
				mk("effect", "devDependency", "3.21.3", "@savvy-web/foo"),
			]);
			expect(subject).toBe(`${PREFIX}bump effect to 3.21.3`);
		});

		it("collapses a dep updated across many workspaces (same name) to one headline", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}bump effect to 3.21.3`);
		});
	});

	describe("only runtimes (rule 5)", () => {
		it("joins two runtimes with 'and' in canonical order", () => {
			const subject = buildUpdateSubject([mk("bun", "runtime", "1.2.0"), mk("node", "runtime", "26.1.0")]);
			expect(subject).toBe(`${PREFIX}upgrade Node and Bun`);
		});

		it("joins three runtimes with an Oxford-style 'and'", () => {
			const subject = buildUpdateSubject([
				mk("deno", "runtime", "2.1.0"),
				mk("bun", "runtime", "1.2.0"),
				mk("node", "runtime", "26.1.0"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade Node, Deno and Bun`);
		});
	});

	describe("only config deps (rule 6)", () => {
		it("summarizes multiple config deps by count", () => {
			const subject = buildUpdateSubject([
				mk("typescript", "config", "5.9.2"),
				mk("biome", "config", "2.0.0"),
				mk("turbo", "config", "2.5.0"),
			]);
			expect(subject).toBe(`${PREFIX}update 3 config dependencies`);
		});

		it("does not count pnpm as a config dep in the summary", () => {
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.7.0"),
				mk("typescript", "config", "5.9.2"),
				mk("biome", "config", "2.0.0"),
			]);
			// pnpm + 2 config deps is mixed -> rule 9, not "3 config dependencies"
			expect(subject).toBe(`${PREFIX}upgrade pnpm and update 2 config dependencies`);
		});
	});

	describe("only regular deps (rules 7-8)", () => {
		it("rule 7: names the workspace when all deps share one non-root package", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/foo"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/foo"),
			]);
			expect(subject).toBe(`${PREFIX}update dependencies in @savvy-web/foo`);
		});

		it("rule 8: breaks mixed types down when spread across workspaces", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/b"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/c"),
			]);
			expect(subject).toBe(`${PREFIX}update 2 dependencies and 1 devDependency`);
		});

		it("rule 8: breaks mixed types down when some land in the root (null package)", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", null),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/foo"),
			]);
			expect(subject).toBe(`${PREFIX}update 1 dependency and 1 devDependency`);
		});

		it("rule 8: root-only multi-dep updates are counted, not workspace-named", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", null),
				mk("zod", "dependency", "4.0.0", null),
			]);
			expect(subject).toBe(`${PREFIX}update 2 dependencies`);
		});
	});

	describe("typed dependency breakdown", () => {
		it("summarizes an all-devDependencies batch with the typed noun", () => {
			const subject = buildUpdateSubject([
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/a"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/b"),
				mk("turbo", "devDependency", "2.5.0", null),
			]);
			expect(subject).toBe(`${PREFIX}update 3 devDependencies`);
		});

		it("summarizes an all-peerDependencies batch with the typed noun", () => {
			const subject = buildUpdateSubject([
				mk("react", "peerDependency", "19.0.0", "@savvy-web/a"),
				mk("effect", "peerDependency", "3.21.3", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}update 2 peerDependencies`);
		});

		it("summarizes an all-optionalDependencies batch with the typed noun", () => {
			const subject = buildUpdateSubject([
				mk("fsevents", "optionalDependency", "2.3.3", "@savvy-web/a"),
				mk("bufferutil", "optionalDependency", "4.0.9", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}update 2 optionalDependencies`);
		});

		it("enumerates three types production-first", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/b"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/c"),
				mk("react", "peerDependency", "19.0.0", "@savvy-web/d"),
			]);
			expect(subject).toBe(`${PREFIX}update 1 dependency, 2 devDependencies and 1 peerDependency`);
		});

		it("counts a name once per type when it appears in two sections", () => {
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("effect", "devDependency", "3.21.3", "@savvy-web/b"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/c"),
			]);
			expect(subject).toBe(`${PREFIX}update 2 dependencies and 1 devDependency`);
		});

		it("composes config + devDependencies with typed nouns", () => {
			const subject = buildUpdateSubject([
				mk("typescript", "config", "5.9.2"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/a"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/b"),
				mk("turbo", "devDependency", "2.5.0", "@savvy-web/c"),
				mk("biome", "devDependency", "2.0.0", "@savvy-web/d"),
			]);
			expect(subject).toBe(`${PREFIX}update 1 config dependency and 4 devDependencies`);
		});

		it("keeps the elliptical config phrasing when regular deps are all plain dependencies", () => {
			const subject = buildUpdateSubject([
				mk("typescript", "config", "5.9.2"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}update 1 config and 2 dependencies`);
		});

		it("composes pnpm + devDependencies with the typed noun", () => {
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.7.0"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/a"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade pnpm and update 2 devDependencies`);
		});

		it("names the workspace with the typed noun when a single-workspace batch is homogeneous", () => {
			const subject = buildUpdateSubject([
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/foo"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/foo"),
			]);
			expect(subject).toBe(`${PREFIX}update devDependencies in @savvy-web/foo`);
		});

		it("composes pnpm + config + devDependencies with typed nouns (the std-osc8#65 shape)", () => {
			// Under the old 72-char budget this degraded to the coarse
			// "update 1 config and 3 dependencies", mislabeling devDependencies.
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.23.0"),
				mk("@effected/pnpm-plugin-effect", "config", "0.6.3"),
				mk("@savvy-web/bundler", "devDependency", "^2.1.22", "std-osc8"),
				mk("@savvy-web/silk", "devDependency", "^3.10.0", "std-osc8"),
				mk("@vitest-agent/plugin", "devDependency", "^2.4.6", "std-osc8"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade pnpm, update 1 config dependency and 3 devDependencies`);
		});

		it("enumerates a config + dependency + devDependency mix (the silk-runtime-action#284 shape)", () => {
			// 73 chars — one over the old budget, so it used to lump a
			// release-triggering dependency and a devDependency as "2 dependencies".
			const subject = buildUpdateSubject([
				mk("@effected/pnpm-plugin-effect", "config", "0.6.1"),
				mk("@effected/markdown", "dependency", "^0.6.1", "@savvy-web/silk-runtime-action"),
				mk("@vitest-agent/plugin", "devDependency", "^2.4.5", "@savvy-web/silk-runtime-action"),
			]);
			expect(subject).toBe(`${PREFIX}update 1 config dependency, 1 dependency and 1 devDependency`);
		});

		it("degrades to the coarse phrasing when the typed breakdown overflows 100 chars", () => {
			const subject = buildUpdateSubject([
				mk("typescript", "config", "5.9.2"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
				mk("vitest", "devDependency", "3.0.0", "@savvy-web/c"),
				mk("tsx", "devDependency", "4.0.0", "@savvy-web/d"),
				mk("react", "peerDependency", "19.0.0", "@savvy-web/e"),
				mk("fsevents", "optionalDependency", "2.3.3", "@savvy-web/f"),
			]);
			// Typed: "update 1 config dependency, 2 dependencies, 2 devDependencies,
			// 1 peerDependency and 1 optionalDependency" — over budget. The coarse
			// form lumps the mixed-section batch as "packages", never as
			// "dependencies", which would misrepresent the devDeps and peers.
			expect(subject).toBe(`${PREFIX}update 1 config dependency and 6 packages`);
		});

		it("lumps a deps-only mixed batch as packages when the enumeration overflows", () => {
			const updates = [
				...Array.from({ length: 10 }, (_, i) => mk(`dep-${i}`, "dependency", "1.0.0", `@savvy-web/p${i}`)),
				...Array.from({ length: 10 }, (_, i) => mk(`dev-${i}`, "devDependency", "1.0.0", `@savvy-web/q${i}`)),
				...Array.from({ length: 11 }, (_, i) => mk(`peer-${i}`, "peerDependency", "1.0.0", `@savvy-web/r${i}`)),
				...Array.from({ length: 10 }, (_, i) => mk(`opt-${i}`, "optionalDependency", "1.0.0", `@savvy-web/s${i}`)),
			];
			expect(buildUpdateSubject(updates)).toBe(`${PREFIX}update 41 packages`);
		});
	});

	describe("mixed categories (rule 9)", () => {
		it("composes pnpm + deps", () => {
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.7.0"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade pnpm and update 2 dependencies`);
		});

		it("merges pnpm + runtime into a single upgrade clause", () => {
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.7.0"),
				mk("node", "runtime", "26.1.0"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade pnpm and Node, update 2 dependencies`);
		});

		it("composes config + deps into one update clause", () => {
			const subject = buildUpdateSubject([
				mk("typescript", "config", "5.9.2"),
				mk("biome", "config", "2.0.0"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}update 2 config and 2 dependencies`);
		});

		it("composes the full upgrade + update shape", () => {
			const subject = buildUpdateSubject([
				mk("pnpm", "packageManager", "11.7.0"),
				mk("node", "runtime", "26.1.0"),
				mk("typescript", "config", "5.9.2"),
				mk("biome", "config", "2.0.0"),
				mk("effect", "dependency", "3.21.3", "@savvy-web/a"),
				mk("zod", "dependency", "4.0.0", "@savvy-web/b"),
			]);
			expect(subject).toBe(`${PREFIX}upgrade pnpm and Node, update 2 config and 2 dependencies`);
		});

		it("keeps the full composed shape within the 100-char budget for a large plain-deps run", () => {
			const updates = [
				mk("pnpm", "packageManager", "11.7.0"),
				mk("node", "runtime", "26.1.0"),
				mk("deno", "runtime", "2.1.0"),
				mk("bun", "runtime", "1.2.0"),
				...Array.from({ length: 12 }, (_, i) => mk(`config-${i}`, "config", "1.0.0")),
				...Array.from({ length: 30 }, (_, i) => mk(`dep-${i}`, "dependency", "1.0.0", `@savvy-web/p${i}`)),
			];
			// Fell back to the generic default under the old 72-char budget.
			expect(buildUpdateSubject(updates)).toBe(
				`${PREFIX}upgrade pnpm, Node, Deno and Bun, update 12 config and 30 dependencies`,
			);
		});
	});

	describe("version display + header-budget guard", () => {
		it("strips a corepack hash suffix from the pnpm version", () => {
			expect(buildUpdateSubject([mk("pnpm", "packageManager", "11.7.0+sha512.deadbeefcafe")])).toBe(
				`${PREFIX}upgrade pnpm to 11.7.0`,
			);
		});

		it("strips a leading range operator from a runtime version", () => {
			expect(buildUpdateSubject([mk("node", "runtime", "^26.1.0")])).toBe(`${PREFIX}upgrade Node to 26.1.0`);
		});

		it("strips a tilde operator from a single config dep version", () => {
			expect(buildUpdateSubject([mk("typescript", "config", "~5.9.2")])).toBe(`${PREFIX}bump typescript to 5.9.2`);
		});

		it("degrades a single-workspace subject to the default when the name overflows 100 chars", () => {
			const long = "@savvy-web/an-absurdly-long-workspace-package-name-engineered-to-overflow-even-the-longer-budget";
			const subject = buildUpdateSubject([
				mk("effect", "dependency", "3.21.3", long),
				mk("zod", "dependency", "4.0.0", long),
			]);
			expect(subject).toBe(`${PREFIX}update dependencies`);
		});
	});

	describe("conventional-commit + length invariants", () => {
		const cases: Array<readonly DependencyUpdateResult[]> = [
			[],
			[mk("pnpm", "packageManager", "11.7.0")],
			[mk("node", "runtime", "26.1.0")],
			[mk("effect", "dependency", "3.21.3", "@savvy-web/foo")],
			[mk("typescript", "config", "5.9.2"), mk("biome", "config", "2.0.0")],
			[mk("pnpm", "packageManager", "11.7.0"), mk("effect", "dependency", "3.21.3", "@savvy-web/a")],
			// Hash-pinned pnpm version must not blow the budget.
			[mk("pnpm", "packageManager", "11.7.0+sha512.0123456789abcdef0123456789abcdef0123456789abcdef")],
			// Long scoped workspace name must degrade rather than overflow.
			[
				mk(
					"effect",
					"dependency",
					"3.21.3",
					"@savvy-web/an-absurdly-long-workspace-package-name-engineered-to-overflow-even-the-longer-budget",
				),
				mk(
					"zod",
					"dependency",
					"4.0.0",
					"@savvy-web/an-absurdly-long-workspace-package-name-engineered-to-overflow-even-the-longer-budget",
				),
			],
			// The std-osc8#65 shape: must render typed, within budget.
			[
				mk("pnpm", "packageManager", "11.23.0"),
				mk("@effected/pnpm-plugin-effect", "config", "0.6.3"),
				mk("a", "devDependency", "1.0.0", "p"),
				mk("b", "devDependency", "1.0.0", "p"),
				mk("c", "devDependency", "1.0.0", "p"),
			],
		];

		cases.forEach((updates, i) => {
			it(`case ${i}: produces a valid <=100 char chore(deps) subject`, () => {
				const subject = buildUpdateSubject(updates);
				expect(subject.startsWith("chore(deps): ")).toBe(true);
				expect(subject.length).toBeLessThanOrEqual(100);
				expect(subject.endsWith(".")).toBe(false);
			});
		});
	});
});
