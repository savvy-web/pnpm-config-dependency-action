/**
 * Logging utilities for the action.
 *
 * Provides debug logging that respects the log-level input.
 *
 * @module logging
 */

import { debug, info } from "@actions/core";
import { Effect } from "effect";

import { isDebugMode } from "./inputs.js";

/**
 * Log a debug message (only when debug mode is enabled).
 */
export const logDebug = (message: string): Effect.Effect<void> =>
	Effect.sync(() => {
		if (isDebugMode()) {
			info(`[DEBUG] ${message}`);
		} else {
			debug(message);
		}
	});

/**
 * Log detailed object state for debugging.
 */
export const logDebugState = (label: string, state: unknown): Effect.Effect<void> =>
	Effect.sync(() => {
		if (isDebugMode()) {
			info(`[DEBUG] ${label}:`);
			info(JSON.stringify(state, null, 2));
		} else {
			debug(`${label}: ${JSON.stringify(state)}`);
		}
	});
