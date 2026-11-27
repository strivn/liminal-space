// Opening the public page and the owner's page, and what each shows: papers, controls, the heatmap, Contents.
import { expect, type Page } from "@playwright/test";
import {
	dateOf,
	Given,
	isPhone,
	nthPaper,
	openPage,
	pageOf,
	reload,
	Then,
	When,
} from "./world.ts";

const OWNER_BUTTONS = ["Abstract", "Paper", "OK", "Like", "Dislike", "Comment"];

// The titles of a day's papers as a page lists them, in order.
function dayTitles(page: Page, date: string) {
	return page
		.locator("article.entry")
		.filter({ hasText: `of ${date}` })
		.locator(".entry__title");
}

// The desktop heatmap's square for `date`.
function square(page: Page, date: string) {
	return page.locator(`.heatmap .heatmap__day[data-date="${date}"]`).first();
}

// Check a day's square: its read count, and, when `crown` is "a" or "no", whether it shows a crown.
async function expectSquare(
	page: Page,
	date: string,
	read: string,
	total: string,
	crown: string | undefined,
) {
	const day = square(page, date);
	await expect
		.soft(day)
		.toHaveAttribute(
			"aria-label",
			new RegExp(` ${read} of ${total} papers read`),
		);
	if (crown === "a" || crown === "no") {
		await expect
			.soft(day.locator('[data-icon="crown"]'))
			.toHaveCount(crown === "a" ? 1 : 0);
	}
}

When(
	"a visitor opens the public page and the owner opens their page",
	async ({ world, browser }) => {
		await openPage(world, browser, "visitor");
		await openPage(world, browser, "owner");
	},
);

When("the owner opens their page", async ({ world, browser }) => {
	await openPage(world, browser, "owner");
});

Given("the window is {int}px wide", ({ world }, width: number) => {
	world.windowWidth = width;
});

When("the owner's sign-in ends", ({ world }) => {
	world.ownerSignedIn = false;
});

When("the owner signs in again", ({ world }) => {
	world.ownerSignedIn = true;
});

Then("the page says {string}", async ({ world, browser }, text: string) => {
	const page = await pageOf(world, browser, "owner");
	await expect.soft(page.getByRole("status")).toContainText(text);
});

Then("the page has no bar with the last 7 days", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "owner");
	// The strip of the last 7 days is in the page on every window, and shows only on a phone.
	const strip = page.locator(".phone-bar__strip");
	await expect.soft(strip).toHaveCount(1);
	await expect.soft(strip).toBeHidden();
});

When(
	/^(?:the owner )?follows a link to the (\d+)(?:st|nd|rd|th) paper of the day 2 months ago$/,
	async ({ world, browser }, n: string) => {
		const page = await pageOf(world, browser, "owner");
		const date = dateOf(world, "the day 2 months ago");
		const paper = nthPaper(world, date, Number(n));
		// The month's file is asked for only once the link is followed.
		const monthFile = `/data/months/${date.slice(0, 7)}.`;
		expect(
			world.requested.filter((asked) => asked.includes(monthFile)),
			"month files asked for before the link",
		).toEqual([]);
		const fetched = page.waitForResponse((response) =>
			response.url().includes(monthFile),
		);
		await page.evaluate((id) => {
			location.hash = id;
		}, paper.id);
		expect((await fetched).status()).toBe(200);
		world.paper = paper;
	},
);

When(/^(?:the owner )?goes back$/, async ({ world, browser }) => {
	const page = await pageOf(world, browser, "owner");
	await page.goBack();
});

When(/^(?:the owner )?reloads the page$/, async ({ world, browser }) => {
	await reload(await pageOf(world, browser, "owner"));
});

Then(
	"both show today's {int} papers in the same order",
	async ({ world, browser }, count: number) => {
		const expected = (world.days.get(world.today) ?? []).map((p) => p.title);
		expect(expected).toHaveLength(count);
		for (const reader of ["visitor", "owner"] as const) {
			const page = await pageOf(world, browser, reader);
			await expect.soft(dayTitles(page, world.today)).toHaveText(expected);
		}
	},
);

// A paper's entry on a page, its line above the title (checked to sit above it), and its title row.
async function headerOf(page: Page, id: string) {
	const entry = page.locator(`article.entry[id="${id}"]`);
	const meta = await entry.locator(".entry__meta").boundingBox();
	const title = await entry.locator(".entry__title").boundingBox();
	expect(meta?.y, "the line sits above the title").toBeLessThan(title?.y ?? 0);
	return entry;
}

Then(
	/^today's (\d+)(?:st|nd|rd|th) paper names NeurIPS (\d+), its DOI and its arXiv id above its title, which opens its published version$/,
	async ({ world, browser }, position: string, year: string) => {
		const paper = nthPaper(world, world.today, Number(position));
		const published = paper.camera_ready;
		expect(published, "the paper has a published version").toBeDefined();
		for (const reader of ["visitor", "owner"] as const) {
			const entry = await headerOf(
				await pageOf(world, browser, reader),
				paper.id,
			);
			await expect
				.soft(entry.locator(".entry__meta"))
				.toHaveText(
					`paper · NeurIPS ${year} · doi:${published?.doi} · arXiv ${paper.id.replace("arxiv:", "")}`,
				);
			await expect
				.soft(entry.locator(".entry__title > a").first())
				.toHaveAttribute("href", published?.url ?? "");
		}
	},
);

Then(
	/^today's (\d+)(?:st|nd|rd|th) paper names PETS (\d+) and its DOI above its title, with the conference mark and no arXiv logo$/,
	async ({ world, browser }, position: string, year: string) => {
		const paper = nthPaper(world, world.today, Number(position));
		for (const reader of ["visitor", "owner"] as const) {
			const entry = await headerOf(
				await pageOf(world, browser, reader),
				paper.id,
			);
			await expect
				.soft(entry.locator(".entry__meta"))
				.toHaveText(
					`paper · PETS ${year} · doi:${paper.id.replace("doi:", "")}`,
				);
			await expect.soft(entry.locator(".entry__conference")).toBeVisible();
			await expect.soft(entry.locator(".entry__arxiv")).toHaveCount(0);
		}
	},
);

Then(
	"only the owner's page has Abstract, Paper, OK, Like, Dislike and Comment buttons",
	async ({ world, browser }) => {
		const owner = await pageOf(world, browser, "owner");
		const visitor = await pageOf(world, browser, "visitor");
		const ownerEntry = owner.locator("article.entry").first();
		const visitorEntry = visitor.locator("article.entry").first();
		for (const name of OWNER_BUTTONS) {
			await expect
				.soft(ownerEntry.getByRole("button", { name, exact: true }))
				.toBeVisible();
			await expect
				.soft(visitorEntry.getByRole("button", { name, exact: true }))
				.toHaveCount(0);
		}
	},
);

Then(
	/^only the owner's page says (today|yesterday)'s square has (\d+) of (\d+) read, with (a|no) crown$/,
	async (
		{ world, browser },
		day: string,
		read: string,
		total: string,
		crown: string,
	) => {
		const date = dateOf(world, day);
		const owner = await pageOf(world, browser, "owner");
		const visitor = await pageOf(world, browser, "visitor");
		await expectSquare(owner, date, read, total, crown);
		await expect.soft(square(visitor, date)).toHaveCount(0);
	},
);

Then(
	/^(today|yesterday)'s square (?:still )?has (\d+) of (\d+) read(?:, with (a|no) crown)?$/,
	async (
		{ world, browser },
		day: string,
		read: string,
		total: string,
		crown?: string,
	) => {
		const page = await pageOf(world, browser, "owner");
		await expectSquare(page, dateOf(world, day), read, total, crown);
	},
);

When(
	/^clicks the (\d+)(?:st|nd|rd|th) title of today in Contents$/,
	async ({ world, browser }, n: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = nthPaper(world, world.today, Number(n));
		const contents = page.getByRole("navigation", { name: "Contents" });
		// On a phone Contents is folded into the bar until its button opens it.
		const box = contents.locator("details.contents__box");
		if ((await isPhone(page)) && (await box.getAttribute("open")) === null) {
			await contents.locator("summary.contents__summary").click();
		}
		await contents
			.getByRole("link", { name: paper.title, exact: true })
			.click();
		world.paper = paper;
	},
);

// Where the window's visible top is: below the bar that sticks there on a phone, else the window's edge.
async function topOfWindow(page: Page): Promise<number> {
	if (!(await isPhone(page))) return 0;
	const bar = await page.locator(".phone-bar").boundingBox();
	if (bar === null) throw new Error("the phone has no bar");
	return bar.y + bar.height;
}

Then(
	"the bar with the last 7 days is at the top of the window",
	async ({ world, browser }) => {
		const page = await pageOf(world, browser, "owner");
		await expect.soft(page.locator(".phone-bar__strip")).toBeVisible();
		const bar = await page.locator(".phone-bar").boundingBox();
		expect.soft(bar?.y ?? -1, "the bar's top in the window").toBeCloseTo(0, 0);
	},
);

Then(
	/^(?:today's (\d+)(?:st|nd|rd|th) paper|that paper) is at the top of the window$/,
	async ({ world, browser }, n: string | undefined) => {
		const page = await pageOf(world, browser, "owner");
		let paper = world.paper;
		if (n) {
			paper = nthPaper(world, world.today, Number(n));
		}
		if (paper === null) {
			throw new Error("no step has named a paper yet");
		}
		const entry = page.locator(`article.entry[id="${paper.id}"]`);
		const top = await topOfWindow(page);
		// The entry's top sits within the top fifth of what the window shows once the scroll settles.
		await expect
			.poll(async () => {
				const box = await entry.boundingBox();
				const height = page.viewportSize()?.height ?? 0;
				return box !== null && box.y >= top - 1 && box.y < top + height / 5;
			})
			.toBe(true);
	},
);
