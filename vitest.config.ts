import { AgentPlugin } from "@vitest-agent/plugin";
import { defineConfig } from "vitest/config";

export default async () => {
	const { projects, tags } = await AgentPlugin.discover();
	return defineConfig({
		plugins: [
			AgentPlugin({
				console: {
					human: "stream",
					agent: "agent",
				},
				coverageTargets: AgentPlugin.COVERAGE_LEVELS.strict.coverageTargets,
			}),
		],
		test: {
			...(projects ? { projects } : {}),
			tags,
			pool: "forks",
			// `vitest.setup.ts` is NOT registered here: AgentPlugin.discover()
			// already points each project's `setupFiles` at it, which is the only
			// registration that works. A `globalSetup` entry runs in a separate
			// process from the test workers, so the runner env vars it strips would
			// still be present in the processes that actually import `src/`.
			coverage: {
				enabled: true,
				provider: "v8",
				thresholds: AgentPlugin.COVERAGE_LEVELS.strict.thresholds,
				exclude: [],
			},
		},
	});
};
