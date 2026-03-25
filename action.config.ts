import { defineConfig } from "@savvy-web/github-action-builder";

export default defineConfig({
	build: {
		minify: false,
	},
	persistLocal: {
		enabled: true,
		path: ".github/actions/local",
	},
});
