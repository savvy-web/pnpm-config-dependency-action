import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	BranchResult,
	ChangesetFile,
	DependencyUpdateResult,
	LockfileChange,
	NonEmptyString,
	PullRequestResult,
} from "./index.js";

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

	it("decodes regular dependency update", () => {
		const result = decode({
			dependency: "effect",
			from: null,
			to: "3.1.0",
			type: "regular",
			package: "@savvy-web/core",
		});
		expect(result.from).toBeNull();
		expect(result.package).toBe("@savvy-web/core");
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

	it("decodes regular lockfile change with affected packages", () => {
		const result = decode({
			type: "regular",
			dependency: "effect",
			from: null,
			to: "3.1.0",
			affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
		});
		expect(result.affectedPackages).toHaveLength(2);
	});
});
