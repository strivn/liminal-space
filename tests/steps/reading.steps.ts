// What the owner saves on a paper: read marks, feedback, comments and highlights, and what the pages show of them.
import { expect, type Locator, type Page } from "@playwright/test";
import {
	dateOf,
	FIRST_SENTENCE,
	isPhone,
	nthPaper,
	openPage,
	type Paper,
	pageOf,
	SECOND_SENTENCE,
	Then,
	When,
	type World,
} from "./world.ts";

// The paper "it" refers to: the one the last step acted on.
function currentPaper(world: World): Paper {
	if (world.paper === null) {
		throw new Error("no step has named a paper yet");
	}
	return world.paper;
}

// A paper's entry on a page.
export function entryOf(page: Page, paper: Paper): Locator {
	return page.locator(`article.entry[id="${paper.id}"]`);
}

// The comment panel, while it is open.
export function commentPanel(page: Page): Locator {
	return page.locator("dialog[open]");
}

// Select one sentence of a paper's abstract, as a reader's drag would.
async function selectSentence(
	page: Page,
	paper: Paper,
	sentence: string,
): Promise<void> {
	await entryOf(page, paper)
		.locator(".entry__abstract")
		.evaluate((abstract, wanted) => {
			const walker = document.createTreeWalker(abstract, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node !== null && !(node.textContent ?? "").includes(wanted)) {
				node = walker.nextNode();
			}
			if (node === null) throw new Error(`the abstract has no "${wanted}"`);
			const start = (node.textContent ?? "").indexOf(wanted);
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + wanted.length);
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}, sentence);
}

// The site's answer to the next change the page posts to an owner route.
function answerTo(page: Page, route: string) {
	return page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/owner/${route}`) &&
			response.request().method() === "POST",
	);
}

// Type a comment into the open comment box and save it, then close the panel once the site has answered; a phone's
// sheet closes by itself.
export async function saveComment(page: Page, text: string): Promise<void> {
	const panel = commentPanel(page);
	const sheet = await isPhone(page);
	await panel.getByRole("textbox", { name: "Comment" }).fill(text);
	const answered = answerTo(page, "comments");
	await panel.getByRole("button", { name: "Save" }).click();
	await answered;
	if (!sheet) {
		await expect(
			panel.locator(".comment__text", { hasText: text }),
		).toBeVisible();
		await page.keyboard.press("Escape");
	}
	await expect(commentPanel(page)).toHaveCount(0);
}

// The Highlight and Comment buttons for a selection: a bar along the bottom on a phone, else beside the selection.
async function selectionButtons(page: Page): Promise<Locator> {
	if (await isPhone(page)) return page.locator(".selection-float--bar");
	return page.locator(".selection-float:not(.selection-float--bar)");
}

// Open a paper's comment box with its Comment button.
export async function openCommentBox(page: Page, paper: Paper): Promise<void> {
	await entryOf(page, paper)
		.getByRole("button", { name: "Comment", exact: true })
		.click();
	await expect(
		commentPanel(page).getByRole("textbox", { name: "Comment" }),
	).toBeVisible();
}

When(
	/^(?:the owner )?marks (today|yesterday)'s (\d+)(?:st|nd|rd|th) paper as read to the (Abstract|Paper)$/,
	async ({ world, browser }, day: string, n: string, depth: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = nthPaper(world, dateOf(world, day), Number(n));
		const button = entryOf(page, paper).getByRole("button", {
			name: depth,
			exact: true,
		});
		// A press is done once the site has answered it, whether it saved it or refused.
		const answered = answerTo(page, "read");
		await button.click();
		await answered;
		world.paper = paper;
	},
);

When(
	/^(?:the owner )?opens yesterday on the heatmap$/,
	async ({ world, browser }) => {
		const page = await pageOf(world, browser, "owner");
		await page
			.locator(`.heatmap .heatmap__day[data-date="${world.yesterday}"]`)
			.click();
		await expect(
			entryOf(page, nthPaper(world, world.yesterday, 1)),
		).toBeVisible();
	},
);

When("gives it OK", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "owner");
	const button = entryOf(page, currentPaper(world)).getByRole("button", {
		name: "OK",
		exact: true,
	});
	const answered = answerTo(page, "feedback");
	await button.click();
	await answered;
	await expect(button).toHaveAttribute("aria-pressed", "true");
});

When("comments {string} on it", async ({ world, browser }, text: string) => {
	const page = await pageOf(world, browser, "owner");
	await openCommentBox(page, currentPaper(world));
	await saveComment(page, text);
});

When(
	"highlights the first sentence of its abstract",
	async ({ world, browser }) => {
		const page = await pageOf(world, browser, "owner");
		const paper = currentPaper(world);
		await selectSentence(page, paper, FIRST_SENTENCE);
		const answered = answerTo(page, "comments");
		await (await selectionButtons(page))
			.getByRole("button", { name: "Highlight" })
			.click();
		await answered;
		await expect(
			entryOf(page, paper).locator(".entry__abstract mark.comment-mark"),
		).toHaveText(FIRST_SENTENCE);
	},
);

When(
	"comments {string} on the second sentence of its abstract",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "owner");
		await selectSentence(page, currentPaper(world), SECOND_SENTENCE);
		await (await selectionButtons(page)).locator(".comment-float").click();
		await saveComment(page, text);
	},
);

When(
	/^swipes today's (\d+)(?:st|nd|rd|th) paper to the left$/,
	async ({ world, browser }, n: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = nthPaper(world, world.today, Number(n));
		const body = entryOf(page, paper).locator(".entry__body");
		const box = await body.boundingBox();
		if (box === null) throw new Error(`${paper.id} shows no text`);
		// A finger moving 200px left across the text, as the touch pointer events the page listens to.
		const y = box.y + box.height / 2;
		const right = box.x + box.width - 20;
		const answered = answerTo(page, "read");
		await body.dispatchEvent("pointerdown", finger(right, y));
		await body.dispatchEvent("pointermove", finger(right - 100, y));
		await body.dispatchEvent("pointermove", finger(right - 200, y));
		await body.dispatchEvent("pointerup", finger(right - 200, y));
		await answered;
		world.paper = paper;
	},
);

// One touch pointer's event at a point in the window.
function finger(x: number, y: number) {
	return {
		pointerId: 7,
		pointerType: "touch",
		isPrimary: true,
		clientX: x,
		clientY: y,
		bubbles: true,
	};
}

Then(
	"the comment box is in a sheet at the bottom of the window",
	async ({ world, browser }) => {
		const page = await pageOf(world, browser, "owner");
		const sheet = commentPanel(page);
		await expect.soft(sheet).toHaveClass(/\bcomment-panel--sheet\b/);
		await expect
			.soft(sheet.getByRole("textbox", { name: "Comment" }))
			.toBeVisible();
		const box = await sheet.boundingBox();
		const height = page.viewportSize()?.height ?? 0;
		expect
			.soft((box?.y ?? 0) + (box?.height ?? 0), "the sheet's bottom")
			.toBeCloseTo(height, 0);
	},
);

Then(
	/^(today|yesterday)'s (\d+)(?:st|nd|rd|th) paper shows read to the (Abstract|Paper)( and OK)?$/,
	async (
		{ world, browser },
		day: string,
		n: string,
		depth: string,
		ok?: string,
	) => {
		const page = await pageOf(world, browser, "owner");
		const entry = entryOf(page, nthPaper(world, dateOf(world, day), Number(n)));
		const names = [depth];
		if (ok) names.push("OK");
		for (const name of names) {
			await expect
				.soft(entry.getByRole("button", { name, exact: true }))
				.toHaveAttribute("aria-pressed", "true");
		}
	},
);

// Open the paper's comments, check one thread, and close the panel again.
async function expectThread(
	page: Page,
	paper: Paper,
	text: string,
	quote: string | null,
): Promise<void> {
	await entryOf(page, paper).locator(".comment-count").click();
	const thread = commentPanel(page)
		.locator(".comment-thread")
		.filter({ has: page.locator(".comment__text", { hasText: text }) });
	await expect.soft(thread).toHaveCount(1);
	if (quote !== null) {
		await expect
			.soft(thread.locator(".comment-thread__quote"))
			.toHaveText(quote);
	}
	await page.keyboard.press("Escape");
}

Then(
	"the paper shows the comment {string}",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "owner");
		await expectThread(page, currentPaper(world), text, null);
	},
);

Then(
	"the paper shows the comment {string} quoting the second sentence of its abstract",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "owner");
		await expectThread(page, currentPaper(world), text, SECOND_SENTENCE);
	},
);

Then(
	"the first sentence of its abstract shows highlighted",
	async ({ world, browser }) => {
		const page = await pageOf(world, browser, "owner");
		await expect
			.soft(
				entryOf(page, currentPaper(world))
					.locator(".entry__abstract mark.comment-mark")
					.first(),
			)
			.toHaveText(FIRST_SENTENCE);
	},
);

Then("the public page shows none of it", async ({ world, browser }) => {
	const page = await openPage(world, browser, "visitor");
	// Yesterday is folded on the public page; what matters is that its entry holds none of the owner's reading.
	const entry = entryOf(page, currentPaper(world));
	await expect.soft(entry).toBeAttached();
	await expect.soft(entry.locator("mark")).toHaveCount(0);
	await expect
		.soft(entry.locator("button[aria-pressed='true']"))
		.toHaveCount(0);
	await expect.soft(entry.locator(".comment-count")).toHaveCount(0);
});
