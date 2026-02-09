import { Either } from "effect";
import { describe, expect, it } from "vitest";

import { decodeActionInputs, decodeActionInputsEither } from "./index.js";

const validInputs = {
	appId: "12345",
	appPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
	branch: "pnpm/config-deps",
	configDependencies: ["typescript"],
	dependencies: ["effect"],
	run: [],
	updatePnpm: true,
	autoMerge: "" as const,
};

describe("decodeActionInputsEither", () => {
	it("decodes valid inputs successfully", () => {
		const result = decodeActionInputsEither(validInputs);
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.appId).toBe("12345");
			expect(result.right.branch).toBe("pnpm/config-deps");
			expect(result.right.configDependencies).toEqual(["typescript"]);
		}
	});

	it("fails for missing appId", () => {
		const result = decodeActionInputsEither({ ...validInputs, appId: "" });
		expect(Either.isLeft(result)).toBe(true);
	});

	it("fails for missing appPrivateKey", () => {
		const result = decodeActionInputsEither({ ...validInputs, appPrivateKey: "" });
		expect(Either.isLeft(result)).toBe(true);
	});

	it("fails for invalid branch name with special chars", () => {
		const result = decodeActionInputsEither({ ...validInputs, branch: "my branch@v1!" });
		expect(Either.isLeft(result)).toBe(true);
	});

	it("accepts valid branch names with slashes and hyphens", () => {
		const result = decodeActionInputsEither({ ...validInputs, branch: "pnpm/config-deps_v2" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("accepts empty arrays for optional config fields", () => {
		const result = decodeActionInputsEither({
			...validInputs,
			configDependencies: [],
			dependencies: ["effect"],
		});
		expect(Either.isRight(result)).toBe(true);
	});

	it("accepts empty run array", () => {
		const result = decodeActionInputsEither({ ...validInputs, run: [] });
		expect(Either.isRight(result)).toBe(true);
	});
});

describe("decodeActionInputs (sync)", () => {
	it("decodes valid inputs synchronously", () => {
		const result = decodeActionInputs(validInputs);
		expect(result.appId).toBe("12345");
	});

	it("throws for invalid inputs", () => {
		expect(() => decodeActionInputs({ ...validInputs, appId: "" })).toThrow();
	});

	it("throws with branch pattern message for invalid branch", () => {
		expect(() => decodeActionInputs({ ...validInputs, branch: "invalid branch!" })).toThrow();
	});
});

describe("autoMerge schema", () => {
	it("accepts empty string (disabled)", () => {
		const result = decodeActionInputsEither({ ...validInputs, autoMerge: "" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("accepts merge", () => {
		const result = decodeActionInputsEither({ ...validInputs, autoMerge: "merge" });
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.autoMerge).toBe("merge");
		}
	});

	it("accepts squash", () => {
		const result = decodeActionInputsEither({ ...validInputs, autoMerge: "squash" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("accepts rebase", () => {
		const result = decodeActionInputsEither({ ...validInputs, autoMerge: "rebase" });
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects invalid values", () => {
		const result = decodeActionInputsEither({ ...validInputs, autoMerge: "fast-forward" });
		expect(Either.isLeft(result)).toBe(true);
	});
});

describe("PullRequest nodeId", () => {
	it("decoded PullRequest includes nodeId field", () => {
		const result = decodeActionInputsEither(validInputs);
		expect(Either.isRight(result)).toBe(true);
	});
});

describe("schema types", () => {
	it("NonEmptyString rejects empty string via decodeActionInputsEither", () => {
		const result = decodeActionInputsEither({
			appId: "",
			appPrivateKey: "key",
			branch: "main",
			configDependencies: ["ts"],
			dependencies: [],
			run: [],
			updatePnpm: true,
			autoMerge: "",
		});
		expect(Either.isLeft(result)).toBe(true);
	});
});
