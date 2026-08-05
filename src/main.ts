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

// Run the main action — Action.run handles all error formatting via formatCause.
// Guarded on the runner's own marker variable, identically to `pre.ts` and
// `post.ts`: without it, merely importing this module runs the whole action as
// a side effect, in any process that touches it.
/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
	await Action.run(program);
}
