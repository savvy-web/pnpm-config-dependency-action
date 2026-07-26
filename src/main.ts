/**
 * Main action entry point.
 *
 * Thin wrapper that calls `Action.run` with the program from `./program.ts`.
 * Separated so tests can import `program` and `runCommands` without triggering
 * module-level execution. The GitHub App token is provisioned in `pre.ts` and
 * read back inside the app layer via `GitHubToken.client()`, so `program` needs
 * only the core services `Action.run` injects — no extra `layer` is required.
 *
 * @module main
 */

import { Action } from "@effected/github-actions";
import { program } from "./program.js";

// Run the main action — Action.run handles all error formatting via formatCause
/* v8 ignore next */
Action.run(program);
