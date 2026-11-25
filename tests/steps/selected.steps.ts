// The owner's marks on papers that shaped their thinking, their public notes, and the public page's Selected.
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import {
	nthPaper,
	OPENALEX_TOPIC,
	openPage,
	pageOf,
	runScript,
	Then,
	When,
} from "./world.ts";

// A save of a mark or a note, as the Worker answers it.
const SAVED = (response: { url(): string; request(): { method(): string } }) =>
	response.url().endsWith("/api/owner/standouts") &&
	response.request().method() === "POST";

When(
	/^(?:the owner )?marks today's (\d+)(?:st|nd|rd|th) paper as shaping their thinking$/,
	async ({ world, browser }, position: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = nthPaper(world, world.today, Number(position));
		const saved = page.waitForResponse(SAVED);
		await page
			.locator("article.entry", { hasText: paper.title })
			.getByRole("button", { name: "Shaped my thinking" })
			.click();
		expect((await saved).status()).toBe(200);
		world.paper = paper;
	},
);

When(
	/^(?:the owner )?writes the note "(.*)" on it in Selected$/,
	async ({ world, browser }, note: string) => {
		const page = await pageOf(world, browser, "owner");
		await page.getByRole("link", { name: "Selected" }).click();
		const saved = page.waitForResponse(SAVED);
		const box = page.getByRole("textbox", { name: "Note" });
		await box.fill(note);
		await box.blur();
		expect((await saved).status()).toBe(200);
	},
);

// The deploy after a night: the day's marks and notes are read from D1, the site is built from them and the Worker
// serves the new build.
When(
	"a visitor opens the public page the next morning",
	async ({ world, browser }) => {
		const pulled = path.join(world.dir, "pulled", "digests.js");
		fs.mkdirSync(path.dirname(pulled), { recursive: true });
		await runScript(world, "deploy/sync.ts", ["pull", "--database", pulled]);
		await runScript(world, "deploy/build-site.ts", [
			pulled,
			path.join(world.dir, "dist"),
		]);
		await world.cloud.harness?.update((options) => options);
		await openPage(world, browser, "visitor", "own");
	},
);

Then("the public page opens on Selected", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "visitor");
	await expect(page.locator("#selected-view")).toBeVisible();
	await expect(page.locator("#digests")).toBeHidden();
	await expect(page.getByRole("link", { name: "Selected" })).toHaveAttribute(
		"aria-current",
		"page",
	);
});

Then(
	/^Selected lists today's (\d+)(?:st|nd|rd|th) paper under its OpenAlex topic, with the note "(.*)"$/,
	async ({ world, browser }, position: string, note: string) => {
		const page = await pageOf(world, browser, "visitor");
		const paper = nthPaper(world, world.today, Number(position));
		await expect(
			page.locator('#selected-view .label[aria-pressed="true"]'),
		).toContainText(OPENALEX_TOPIC);
		const listed = page.locator("#selected-view .standout", {
			hasText: paper.title,
		});
		await expect(listed.locator(".standout__text")).toHaveText(note);
	},
);
