/**
 * Main action entry point.
 *
 * Thin wrapper that calls `Action.run` with the program from `./program.ts`.
 * Separated so tests can import `program` and `runCommands` without
 * triggering module-level execution.
 *
 * @module main
 */

import { Action, GitHubAppLive } from "@savvy-web/github-action-effects";
import { program } from "./program.js";

// Run the main action — Action.run handles all error formatting via formatCause
/* v8 ignore next */
Action.run(program, { layer: GitHubAppLive });
