// The end-to-end scenarios: playwright-bdd turns features/*.feature into Playwright tests, the phone ones in WebKit
// on a phone's screen and every other one in headless Google Chrome.
import { defineConfig, devices } from "@playwright/test";
import { defineBddProject } from "playwright-bdd";

// Each project generates its own scenarios, chosen by tag.
function scenarios(name: string, tags: string) {
	return defineBddProject({
		name: name,
		features: "features/*.feature",
		steps: "tests/steps/*.ts",
		tags: tags,
	});
}

export default defineConfig({
	// Two workers locally; GitHub's runner takes half its cores.
	workers: process.env.CI ? "50%" : 2,
	fullyParallel: true,
	timeout: 60_000,
	use: {
		headless: true,
		actionTimeout: 10_000,
		serviceWorkers: "block",
	},
	projects: [
		{
			...scenarios("chrome", "not @live and not @phone"),
			use: {
				...devices["Desktop Chrome"],
				channel: "chrome",
				launchOptions: { chromiumSandbox: true },
			},
		},
		{
			...scenarios("phone", "@phone and not @live"),
			use: { ...devices["iPhone 17 Pro Max"] },
		},
	],
});
