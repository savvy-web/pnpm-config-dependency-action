/**
 * Per-worker test setup: strip the runner's own environment from the test
 * process.
 *
 * Registered as `setupFiles` (by `AgentPlugin.discover()`, which points the
 * project at this file), NOT as `globalSetup` — the distinction is
 * load-bearing. `globalSetup` runs in a separate process from the test
 * workers, so anything it deleted from `process.env` would be invisible to the
 * tests that need it gone. `setupFiles` runs inside each worker, before the
 * test file's own imports are evaluated.
 *
 * Two failure modes this prevents, both of which only appear under a real
 * runner (`GITHUB_ACTIONS=true`) and are therefore invisible locally:
 *
 * 1. **Entry points execute as an import side effect.** `src/pre.ts`,
 *    `src/main.ts` and `src/post.ts` end in
 *    `if (process.env.GITHUB_ACTIONS) await Action.run(...)`, and
 *    `__test__/unit/{pre,post}.test.ts` import those modules. With the marker
 *    set, importing the module under test runs the real phase — including a
 *    live `GitHubToken.provision` — mid-suite.
 * 2. **Real runner values leak into input and environment reads.**
 *    `ActionInput` resolves `INPUT_*` and `ActionEnvironment` snapshots
 *    `GITHUB_*` / `RUNNER_*` at layer construction. A suite that injects its
 *    own provider would otherwise silently read CI's values wherever it
 *    forgot to, and pass for the wrong reason.
 *
 * `TEST_LOGS` (the suites' own opt-in for log output) is deliberately outside
 * every prefix stripped here.
 *
 * @module vitest.setup
 */

/** Variable-name prefixes the GitHub Actions runner owns. */
const RUNNER_PREFIXES = ["INPUT_", "GITHUB_", "RUNNER_", "ACTIONS_"] as const;

for (const key of Object.keys(process.env)) {
	if (RUNNER_PREFIXES.some((prefix) => key.startsWith(prefix))) {
		delete process.env[key];
	}
}
