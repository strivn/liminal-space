// Asking Claude in a comment: the stand-in for Anthropic's API, the @ suggestion, the mention's colour and the reply.
import { expect, type Locator, type Page } from "@playwright/test";
import { commentPanel, entryOf, openCommentBox } from "./reading.steps.ts";
import { Given, nthPaper, pageOf, Then, When, type World } from "./world.ts";

// The question each scenario asked Claude.
const asked = new WeakMap<World, string>();

// The comment box of the open panel.
function commentBox(page: Page): Locator {
	return commentPanel(page).getByRole("textbox", { name: "Comment" });
}

// Whether every element of `mentions` is drawn in the colour of the page's --claude token.
async function inClaudesColour(mentions: Locator): Promise<boolean[]> {
	return mentions.evaluateAll((nodes) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--claude)";
		document.body.append(probe);
		const token = getComputedStyle(probe).color;
		probe.remove();
		return nodes.map((node) => getComputedStyle(node).color === token);
	});
}

Given("Claude will answer {string}", ({ world }, reply: string) => {
	world.cloud.anthropicAnswer = {
		kind: "text",
		pieces: [reply.replaceAll("\\n", "\n")],
		gate: null,
	};
});

When(
	/^the owner comments "(.*)" on today's (\d+)(?:st|nd|rd|th) paper$/,
	async ({ world, browser }, text: string, n: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = nthPaper(world, world.today, Number(n));
		world.paper = paper;
		asked.set(world, text);
		await openCommentBox(page, paper);
		// A question to Claude is done once its answer has come back in full.
		const answered = page.waitForResponse((response) =>
			response.url().endsWith("/api/owner/ask"),
		);
		await commentBox(page).fill(text);
		await commentPanel(page).getByRole("button", { name: "Save" }).click();
		await answered;
		await expect(commentPanel(page).locator(".comment__claude")).toBeVisible();
		await page.keyboard.press("Escape");
	},
);

When(
	/^the owner types "(.*)" in a new comment on today's (\d+)(?:st|nd|rd|th) paper$/,
	async ({ world, browser }, text: string, n: string) => {
		const page = await pageOf(world, browser, "owner");
		await openCommentBox(page, nthPaper(world, world.today, Number(n)));
		await commentBox(page).pressSequentially(text);
	},
);

Then(
	"the comment box suggests {string} after the {string}",
	async ({ world, browser }, suggestion: string, typed: string) => {
		const page = await pageOf(world, browser, "owner");
		// The grey suggestion sits in the layer behind the box, right after what was typed.
		const layer = commentPanel(page).locator(".comment-editor__layer");
		await expect
			.soft(layer.locator(".comment-editor__suggestion"))
			.toHaveText(suggestion);
		await expect.soft(layer).toContainText(`${typed}${suggestion}`);
	},
);

When(/^(?:the owner )?presses Tab$/, async ({ world, browser }) => {
	const page = await pageOf(world, browser, "owner");
	await commentBox(page).press("Tab");
});

Then(
	"the comment box reads {string}",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "owner");
		await expect(commentBox(page)).toHaveValue(text);
	},
);

Then(
	"{string} shows in Claude's orange in the comment box and in the saved comment",
	async ({ world, browser }, mention: string) => {
		const page = await pageOf(world, browser, "owner");
		const paper = world.paper;
		const question = asked.get(world);
		if (paper === null || question === undefined) {
			throw new Error("no comment was made");
		}
		// While typing: the layer behind the box draws the mention.
		await openCommentBox(page, paper);
		await commentBox(page).fill(question);
		const typed = commentPanel(page).locator(
			".comment-editor__layer .claude-mention",
		);
		await expect.soft(typed).toHaveText([mention]);
		expect.soft(await inClaudesColour(typed)).toEqual([true]);
		// Once saved: the owner's comment draws it the same way.
		const saved = commentPanel(page)
			.locator(".comment")
			.filter({ hasText: question })
			.locator(".comment__text .claude-mention");
		await expect.soft(saved).toHaveText([mention]);
		expect.soft(await inClaudesColour(saved)).toEqual([true]);
	},
);

// Open the asked paper's comments, unless they are open, and give back Claude's reply in them.
async function claudesReply(page: Page, world: World): Promise<Locator> {
	const paper = world.paper;
	if (paper === null) {
		throw new Error("no comment was made");
	}
	if ((await commentPanel(page).count()) === 0) {
		await entryOf(page, paper).locator(".comment-count").click();
	}
	return commentPanel(page)
		.locator(".comment")
		.filter({ has: page.locator(".comment__claude") })
		.locator(".comment__text");
}

Then("Claude's reply shows under the question", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "owner");
	const reply = await claudesReply(page, world);
	await expect(reply).toHaveCount(1);
	const thread = commentPanel(page).locator(".comment-thread");
	await expect
		.soft(thread.locator(".comment__text").first())
		.toHaveText(asked.get(world) ?? "");
});

Then(
	"it shows {string} in bold, the formula typeset, a list of {int} items and a link to {string}",
	async ({ world, browser }, bold: string, items: number, link: string) => {
		const page = await pageOf(world, browser, "owner");
		const reply = await claudesReply(page, world);
		await expect.soft(reply.locator("strong")).toHaveText([bold]);
		await expect.soft(reply.locator(".katex")).toHaveCount(1);
		await expect.soft(reply.locator("li")).toHaveCount(items);
		await expect.soft(reply.locator(`a[href="${link}"]`)).toHaveCount(1);
	},
);

Then(
	"Claude's reply shows its first 3 lines and {string}",
	async ({ world, browser }, button: string) => {
		const page = await pageOf(world, browser, "owner");
		const reply = await claudesReply(page, world);
		// Measured once drawn from Markdown, not its plain first draw.
		await expect(reply).toHaveClass(/comment__text--markdown/);
		const lines = await reply.evaluate((text) => {
			const line = parseFloat(getComputedStyle(text).lineHeight);
			return {
				shown: Math.round(text.clientHeight / line),
				cut: text.scrollHeight > text.clientHeight,
			};
		});
		expect.soft(lines).toEqual({ shown: 3, cut: true });
		await expect
			.soft(
				commentPanel(page)
					.locator(".comment")
					.filter({ has: page.locator(".comment__claude") })
					.getByRole("button", { name: button, exact: true }),
			)
			.toBeVisible();
	},
);

// A thread's card, found by its first comment.
function threadOf(page: Page, first: string): Locator {
	return commentPanel(page)
		.locator(".comment-thread")
		.filter({ has: page.locator(".comment__text", { hasText: first }) });
}

When("the owner opens {string}", async ({ world, browser }, button: string) => {
	const page = await pageOf(world, browser, "owner");
	await threadOf(page, asked.get(world) ?? "")
		.getByRole("button", { name: button, exact: true })
		.click();
});
