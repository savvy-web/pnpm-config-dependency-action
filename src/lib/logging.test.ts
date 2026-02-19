import { describe, expect, it, vi } from "vitest";

// Mock @actions/core before imports
vi.mock("@actions/core", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
}));

import { debug, info } from "@actions/core";
import { Effect } from "effect";
import * as inputs from "./inputs.js";
import { logDebug, logDebugState } from "./logging.js";

describe("logDebug", () => {
	it("calls info with [DEBUG] prefix when debug mode is enabled", async () => {
		vi.spyOn(inputs, "isDebugMode").mockReturnValue(true);

		await Effect.runPromise(logDebug("test message"));

		expect(info).toHaveBeenCalledWith("[DEBUG] test message");
		expect(debug).not.toHaveBeenCalled();

		vi.restoreAllMocks();
	});

	it("calls debug when debug mode is disabled", async () => {
		vi.spyOn(inputs, "isDebugMode").mockReturnValue(false);

		await Effect.runPromise(logDebug("test message"));

		expect(debug).toHaveBeenCalledWith("test message");

		vi.restoreAllMocks();
	});
});

describe("logDebugState", () => {
	it("calls info with formatted JSON when debug mode is enabled", async () => {
		vi.spyOn(inputs, "isDebugMode").mockReturnValue(true);

		const state = { key: "value", count: 42 };
		await Effect.runPromise(logDebugState("My state", state));

		expect(info).toHaveBeenCalledWith("[DEBUG] My state:");
		expect(info).toHaveBeenCalledWith(JSON.stringify(state, null, 2));

		vi.restoreAllMocks();
	});

	it("calls debug with single-line JSON when debug mode is disabled", async () => {
		vi.spyOn(inputs, "isDebugMode").mockReturnValue(false);

		const state = { key: "value" };
		await Effect.runPromise(logDebugState("My state", state));

		expect(debug).toHaveBeenCalledWith(`My state: ${JSON.stringify(state)}`);

		vi.restoreAllMocks();
	});
});
