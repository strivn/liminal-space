// Vitest runs the unit tests
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		// Some tests run a script that waits on a local stand-in for several seconds; the 5 s default would cut them off.
		// 60 s matches the limit the tests give each script run.
		testTimeout: 60000,
	},
});
