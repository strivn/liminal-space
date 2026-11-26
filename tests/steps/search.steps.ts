// The Search sentence in the Feed's sidebar: the subject, kind, venue, time and read blanks, and what the Feed shows.
import { expect, type Page } from "@playwright/test";
import type { World } from "./world.ts";
import {
	Given,
	nthPaper,
	OPENALEX_TOPIC,
	openPage,
	Then,
	When,
} from "./world.ts";

// The one page a scenario has open.
function openedPage(world: World): Page {
	const [page] = world.pages.values();
	if (page === undefined) throw new Error("no step has opened a page yet");
	return page;
}

// The entries the Feed shows now: not hidden by the sentence, not in a folded day.
function shownTitles(page: Page) {
	return page.locator("main article.entry:visible .entry__title");
}

// Open the sentence's blank `name` unless its choices are already open, and give back the choices.
async function openBlank(page: Page, name: string) {
	const blank = page.locator(`[data-blank="${name}"]`);
	if ((await blank.getAttribute("aria-expanded")) !== "true") {
		await blank.click();
	}
	return page.locator(".search__choices");
}

Given(
	/^(\d+) of today's papers have the OpenAlex topic "(.*)"$/,
	({ world }, count: string, topic: string) => {
		const papers = (world.days.get(world.today) ?? []).slice(0, Number(count));
		expect(papers, "today's papers").toHaveLength(Number(count));
		for (const paper of papers) {
			paper.openalex.topics = [
				{ name: topic, field: "Computer Science", score: 0.9 },
			];
		}
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper has the OpenAlex keyword "(.*)"$/,
	async ({ world }, position: string, keyword: string) => {
		throw new Error(`not implemented: ${world.dir} ${position} ${keyword}`);
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper's venue is "(.*)" and its (\d+)(?:st|nd|rd|th) paper's is "(.*)"$/,
	({ world }, first: string, venue: string, second: string, other: string) => {
		nthPaper(world, world.today, Number(first)).venue = venue;
		nthPaper(world, world.today, Number(second)).venue = other;
	},
);

When("a visitor opens the public page", async ({ world, browser }) => {
	await openPage(world, browser, "visitor");
});

When(
	/^picks "(.*)" as the (subject|kind|venue) in Search$/,
	async ({ world }, choice: string, blank: string) => {
		const page = openedPage(world);
		const choices = await openBlank(page, blank);
		if (blank === "subject") {
			// Typing in the box lists the topics and keywords that hold the letters, so a topic of few papers is in view.
			await choices.getByRole("searchbox").fill(choice);
			await choices.getByRole("button", { name: choice, exact: true }).click();
		} else {
			await choices.getByRole("radio", { name: choice, exact: true }).click();
		}
	},
);

When(
	/^picks "(.*)" and "(.*)" in Search$/,
	async ({ world }, time: string, read: string) => {
		const page = openedPage(world);
		let choices = await openBlank(page, "time");
		await choices.getByRole("radio", { name: time, exact: true }).click();
		choices = await openBlank(page, "read");
		await choices.getByRole("radio", { name: read, exact: true }).click();
	},
);

When(
	/^clicks the keyword "(.*)" under today's (\d+)(?:st|nd|rd|th) paper$/,
	async ({ world, browser }, keyword: string, position: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${keyword} ${position}`,
		);
	},
);

Then(/^Search reads "(.*)"$/, async ({ world, browser }, words: string) => {
	throw new Error(
		`not implemented: ${world.dir} ${browser.version()} ${words}`,
	);
});

Then(
	/^the Feed shows those (\d+) papers and nothing else$/,
	async ({ world }, count: string) => {
		// Every seeded paper has the one default topic; the papers a step gave another are those.
		const wanted = (world.days.get(world.today) ?? [])
			.filter((paper) => paper.openalex.topics[0]?.name !== OPENALEX_TOPIC)
			.map((paper) => paper.title);
		expect(wanted, "the papers given the topic").toHaveLength(Number(count));
		await expect(shownTitles(openedPage(world))).toHaveText(wanted);
	},
);

Then(
	/^the Feed shows today's (\d+)(?:st|nd|rd|th)(?: and (\d+)(?:st|nd|rd|th))? papers? and nothing else$/,
	async ({ world }, first: string, second: string | undefined) => {
		const positions = [first, second].filter((one) => one !== undefined);
		const wanted = positions.map(
			(position) => nthPaper(world, world.today, Number(position)).title,
		);
		await expect(shownTitles(openedPage(world))).toHaveText(wanted);
	},
);

Then(
	/^the Feed shows (\d+) papers, every one unread$/,
	async ({ world }, count: string) => {
		const page = openedPage(world);
		await expect(shownTitles(page)).toHaveCount(Number(count));
		const read = page.locator(
			'main article.entry:visible button[data-depth][aria-pressed="true"]',
		);
		await expect(read).toHaveCount(0);
	},
);
