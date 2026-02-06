import { describe, expect, it } from "vitest";

import type { LockfileChange } from "../../types/index.js";
import { groupChangesByPackage } from "./compare.js";

describe("groupChangesByPackage", () => {
	it("groups config changes under (root) key", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "config", dependency: "biome", from: "1.5.0", to: "1.6.1", affectedPackages: [] },
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(1);
		expect(result.has("(root)")).toBe(true);
		expect(result.get("(root)")).toHaveLength(2);
	});

	it("groups regular changes by affected package names", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
			{
				type: "regular",
				dependency: "zod",
				from: "3.22.0",
				to: "3.23.0",
				affectedPackages: ["@savvy-web/utils"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.get("@savvy-web/core")).toHaveLength(1);
		expect(result.get("@savvy-web/core")?.[0].dependency).toBe("effect");
		expect(result.get("@savvy-web/utils")).toHaveLength(1);
		expect(result.get("@savvy-web/utils")?.[0].dependency).toBe("zod");
	});

	it("handles changes affecting multiple packages", () => {
		const changes: LockfileChange[] = [
			{
				type: "regular",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.get("@savvy-web/core")).toHaveLength(1);
		expect(result.get("@savvy-web/utils")).toHaveLength(1);
	});

	it("handles empty changes array", () => {
		const result = groupChangesByPackage([]);
		expect(result.size).toBe(0);
	});

	it("handles mix of config and regular changes", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.has("(root)")).toBe(true);
		expect(result.has("@savvy-web/core")).toBe(true);
	});

	it("accumulates multiple changes for the same package", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
			{
				type: "regular",
				dependency: "@effect/schema",
				from: "0.60.0",
				to: "0.61.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(1);
		expect(result.get("@savvy-web/core")).toHaveLength(2);
	});
});
