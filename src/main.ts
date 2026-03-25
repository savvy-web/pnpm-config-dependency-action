/**
 * Main action entry point.
 *
 * Thin wrapper that calls `Action.run` with the program from `./program.ts`.
 * Separated so tests can import `program` and `runCommands` without
 * triggering module-level execution.
 *
 * @module main
 */

import { Action, GitHubAppLive, OctokitAuthAppLive } from "@savvy-web/github-action-effects";
import { Layer } from "effect";
import { program } from "./program.js";

// GitHubAppLive requires OctokitAuthApp — wire them together
const AppLayer = GitHubAppLive.pipe(Layer.provide(OctokitAuthAppLive));

// Run the main action — Action.run handles all error formatting via formatCause
/* v8 ignore next */
Action.run(program, { layer: AppLayer });
