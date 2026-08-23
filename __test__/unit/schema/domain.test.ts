import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	BranchResult,
	ChangesetFile,
	DependencyType,
	DependencyUpdateResult,
	LockfileChange,
	NonEmptyString,
	PeerIssue,
	PullRequestResult,
} from "../../../src/schema/domain.js";

describe("NonEmptyString", () => {
	const decode = Schema.decodeUnknownSync(NonEmptyString);

	it("accepts non-empty strings", () => {
		expect(decode("hello")).toBe("hello");
	});

	it("rejects empty strings", () => {
		expect(() => decode("")).toThrow();
	});
});

describe("BranchResult", () => {
	const decode = Schema.decodeUnknownSync(BranchResult);

	it("decodes valid branch result", () => {
		const result = decode({
			branch: "pnpm/config-deps",
			created: true,
			upToDate: true,
			baseRef: "main",
		});
		expect(result.branch).toBe("pnpm/config-deps");
		expect(result.created).toBe(true);
	});

	it("rejects empty branch name", () => {
		expect(() => decode({ branch: "", created: true, upToDate: true, baseRef: "main" })).toThrow();
	});
});

describe("DependencyUpdateResult", () => {
	const decode = Schema.decodeUnknownSync(DependencyUpdateResult);

	it("decodes config dependency update", () => {
		const result = decode({
			dependency: "typescript",
			from: "5.3.0",
			to: "5.4.0",
			type: "config",
			package: null,
		});
		expect(result.type).toBe("config");
		expect(result.package).toBeNull();
	});

	it("decodes devDependency update", () => {
		const result = decode({
			dependency: "effect",
			from: null,
			to: "3.1.0",
			type: "devDependency",
			package: "@savvy-web/core",
		});
		expect(result.from).toBeNull();
		expect(result.package).toBe("@savvy-web/core");
	});

	it("decodes peerDependency update", () => {
		const result = decode({
			dependency: "react",
			from: "^18.0.0",
			to: "^19.0.0",
			type: "peerDependency",
			package: "@savvy-web/ui",
		});
		expect(result.type).toBe("peerDependency");
	});

	it("decodes optionalDependency update", () => {
		const result = decode({
			dependency: "fsevents",
			from: "2.3.0",
			to: "2.4.0",
			type: "optionalDependency",
			package: null,
		});
		expect(result.type).toBe("optionalDependency");
	});

	it("accepts type 'runtime'", () => {
		const decoded = Schema.decodeUnknownSync(DependencyUpdateResult)({
			dependency: "node",
			from: "^24.0.0",
			to: "^24.16.0",
			type: "runtime",
			package: null,
		});
		expect(decoded.type).toBe("runtime");
	});
});

describe("ChangesetFile", () => {
	const decode = Schema.decodeUnknownSync(ChangesetFile);

	it("decodes valid changeset file", () => {
		const result = decode({
			id: "abc123",
			packages: ["@savvy-web/core"],
			type: "patch",
			summary: "Update dependencies",
		});
		expect(result.id).toBe("abc123");
		expect(result.type).toBe("patch");
	});
});

describe("PullRequestResult", () => {
	const decode = Schema.decodeUnknownSync(PullRequestResult);

	it("decodes valid pull request", () => {
		const result = decode({
			number: 42,
			url: "https://github.com/owner/repo/pull/42",
			created: true,
			nodeId: "PR_abc123",
		});
		expect(result.number).toBe(42);
		expect(result.nodeId).toBe("PR_abc123");
	});

	it("rejects non-https URL", () => {
		expect(() =>
			decode({
				number: 1,
				url: "http://github.com/pull/1",
				created: true,
				nodeId: "id",
			}),
		).toThrow();
	});
});

describe("LockfileChange", () => {
	const decode = Schema.decodeUnknownSync(LockfileChange);

	it("decodes config lockfile change", () => {
		const result = decode({
			type: "config",
			dependency: "typescript",
			from: "5.3.0",
			to: "5.4.0",
			affectedPackages: [],
		});
		expect(result.type).toBe("config");
	});

	it("decodes dependency lockfile change with affected packages", () => {
		const result = decode({
			type: "dependency",
			dependency: "effect",
			from: null,
			to: "3.1.0",
			affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
		});
		expect(result.affectedPackages).toHaveLength(2);
	});
});

describe("PeerIssue", () => {
	const decode = Schema.decodeUnknownSync(PeerIssue);

	it("decodes an unmet peer, carrying the version that was actually resolved", () => {
		const issue = decode({
			importer: ".",
			dependency: "react",
			wanted: "^18.3.1",
			found: "17.0.2",
			optional: false,
			parents: ["react-dom@18.3.1"],
		});
		expect(issue.found).toBe("17.0.2");
		expect(issue.optional).toBe(false);
	});

	// `found: null` IS the missing case. A separate discriminant would be a
	// second source of truth for the same fact and could contradict this one.
	it("decodes a missing peer as a null found", () => {
		const issue = decode({
			importer: "packages/app",
			dependency: "react",
			wanted: "^18.3.1",
			found: null,
			optional: false,
			parents: ["react-dom@18.3.1"],
		});
		expect(issue.found).toBeNull();
	});

	it("rejects an empty dependency name", () => {
		expect(() =>
			decode({ importer: ".", dependency: "", wanted: "^1", found: null, optional: false, parents: [] }),
		).toThrow();
	});
});

describe("DependencyType and the upstream table vocabulary", () => {
	// Every value this action puts in a row's Type cell has to be a value CSH005
	// accepts, and the two live in different repositories. Getting this wrong
	// fails in the CONSUMER's repository — the action opens a PR whose changeset
	// the consumer's own `savvy changeset check` then rejects — so it must fail
	// here instead. The check is a subset assertion against the shipped schema
	// rather than a copy of its literals: a copied list goes stale silently, an
	// assertion fails the build and names the offending member.
	type UnsatisfiedByUpstream = Exclude<typeof DependencyType.Type, SilkChangesets.DependencyTableType>;
	const _everyLocalTypeIsInTheUpstreamVocabulary: [UnsatisfiedByUpstream] extends [never]
		? true
		: UnsatisfiedByUpstream = true;

	it("declares only members the upstream vocabulary accepts", () => {
		// The teeth are the annotation above; this proves the module evaluated.
		expect(_everyLocalTypeIsInTheUpstreamVocabulary).toBe(true);

		// ...and the runtime half, which the type-level check cannot see: decode
		// each of our literals through the very schema CSH005 enforces.
		const upstream = Schema.decodeUnknownSync(SilkChangesets.DependencyTableTypeSchema);
		for (const literal of DependencyType.literals) {
			expect(upstream(literal)).toBe(literal);
		}
	});

	it("carries the two types that used to be mislabelled", () => {
		// Regression pin for #327. `packageManager` replaced a
		// `type === "config" && dependency === "pnpm"` name match that mislabelled
		// the row AND silently covered neither bun nor npm; `runtime` was local-only
		// and could never reach the shared table.
		expect(DependencyType.literals).toContain("packageManager");
		expect(DependencyType.literals).toContain("runtime");
	});
});
