import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/src/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		setupFiles: ["./vitest.setup.ts"],
		testTimeout: 30000,
		reporters: ["default"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", ["html", { subdir: "report" }]],
			reportsDirectory: "./.coverage",
			exclude: [
				"src/main.ts",
				"src/pre.ts",
				"src/post.ts",
				"src/lib/services/index.ts",
				"src/lib/logging.ts",
				"src/lib/github/branch.ts",
				"src/types/**",
				"src/lib/errors/**",
				"src/lib/lockfile/compare.ts",
				"src/lib/pnpm/upgrade.ts",
			],
			enabled: true,
			thresholds: {
				perFile: true, // Enforce thresholds per file instead of globally
				lines: 85,
				functions: 85,
				branches: 85,
				statements: 85,
			},
		},
	},
});
