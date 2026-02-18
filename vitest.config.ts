import { VitestConfig } from "@savvy-web/vitest";

export default VitestConfig.create(({ projects, coverage, reporters }) => ({
	test: {
		reporters,
		projects: projects.map((p) => p.toConfig()),
		coverage: {
			provider: "v8",
			...coverage,
			exclude: [...coverage.exclude, "src/types/**/*.ts", "**/*.d.ts"],
		},
	},
}));
