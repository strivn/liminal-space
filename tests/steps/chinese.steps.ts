// Chinese entries and their word tooltips: the entry the digest holds, and what a reader sees when the mouse rests on a word.
import { expect, type Locator, type Page } from "@playwright/test";
import type { StudyPiece, StudyWord } from "../../shared/study-protocol.ts";
import {
	type ChineseEntry,
	Given,
	nthPaper,
	pageOf,
	Then,
	When,
	type World,
} from "./world.ts";

const ENTRY_URL = "https://example.com/news/valuation-410-billion";
// A word's meaning waits this long after the hover; a step allows the tooltip's own fade on top of it.
const MEANING_WAIT_MS = 1000;

function word(
	text: string,
	syllables: string[],
	meaning: string,
	overrides: Partial<StudyWord> = {},
): StudyWord {
	return {
		text: text,
		syllables: syllables,
		meaning: meaning,
		meaningFrom: "dictionary",
		name: false,
		inDictionary: true,
		pinyinChecked: true,
		...overrides,
	};
}

// The words of the one Chinese title the scenarios use, as the daily job would prepare them.
const TITLE = "估值 410 亿美元，贝佐斯打造「物理世界的 OpenAI」";
const TITLE_PIECES: StudyPiece[] = [
	word("估值", ["gū", "zhí"], "valuation"),
	{ text: " 410 " },
	word("亿", ["yì"], "hundred million"),
	word("美元", ["měi", "yuán"], "U.S. dollar"),
	{ text: "，" },
	word("贝佐斯", ["bèi", "zuǒ", "sī"], "Bezos", {
		meaningFrom: "model",
		name: true,
		inDictionary: false,
	}),
	word("打造", ["dǎ", "zào"], "to build"),
	{ text: "「" },
	word("物理", ["wù", "lǐ"], "physics"),
	word("世界", ["shì", "jiè"], "world"),
	word("的", ["de"], "of"),
	{ text: " OpenAI」" },
];

function chineseEntry(date: string, title: string): ChineseEntry {
	const joined = TITLE_PIECES.map((piece) => piece.text).join("");
	if (title !== TITLE || joined !== TITLE) {
		throw new Error(`the step code holds the words of "${TITLE}" only`);
	}
	const id = `url:${ENTRY_URL}`;
	return {
		entry: {
			id: id,
			type: "news",
			title: title,
			published: date,
			source: "Example News",
			url: ENTRY_URL,
		},
		study: { id: id, title: TITLE_PIECES, description: [] },
	};
}

function chineseOf(world: World): ChineseEntry {
	if (world.chinese === null) {
		throw new Error("no step has given today a Chinese entry yet");
	}
	return world.chinese;
}

// The Chinese entry's title on a page.
function chineseTitle(page: Page, world: World): Locator {
	return page
		.locator(`article.entry[id="${chineseOf(world).entry.id}"]`)
		.locator(".entry__title");
}

// Where `text` is drawn inside `field`, as a point in the window.
async function centreOf(field: Locator, text: string) {
	await field.scrollIntoViewIfNeeded();
	return field.evaluate((element, wanted) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = (node.nodeValue ?? "").indexOf(wanted);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + wanted.length);
			const box = range.getBoundingClientRect();
			return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		}
		throw new Error(`the field has no "${wanted}"`);
	}, text);
}

// The tooltip's word, and the box of one character in it.
const tooltip = (page: Page) => page.locator(".study-tip");
const character = (page: Page, text: string) =>
	page.locator(".study-char", {
		has: page.locator(".study-char__name b", { hasText: text }),
	});

Given(
	"today has an entry in Chinese, {string}, with its words prepared",
	({ world }, title: string) => {
		world.chinese = chineseEntry(world.today, title);
	},
);

When(
	"the visitor hovers {string} in the Chinese entry's title",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "visitor");
		const point = await centreOf(chineseTitle(page, world), text);
		world.hoveredAt = Date.now();
		await page.mouse.move(point.x, point.y);
	},
);

Then(
	"the visitor sees {string} under {string}, and a second later {string}",
	async ({ world, browser }, pinyin: string, text: string, meaning: string) => {
		const page = await pageOf(world, browser, "visitor");
		const shownWord = tooltip(page).locator(".study-tip__word");
		const shownPinyin = tooltip(page).locator(".study-tip__pinyin");
		await expect.soft(shownWord).toHaveText(text);
		await expect.soft(shownPinyin).toHaveText(pinyin);
		const word = await shownWord.boundingBox();
		const under = await shownPinyin.boundingBox();
		expect
			.soft(under?.y ?? 0, "the pinyin's top")
			.toBeGreaterThanOrEqual((word?.y ?? 0) + (word?.height ?? 0) - 1);
		const shownMeaning = tooltip(page).locator(".study-tip__meaning");
		await expect.soft(shownMeaning).toContainText(meaning);
		await expect.soft(shownMeaning).toHaveCSS("opacity", "1");
		expect
			.soft(Date.now() - world.hoveredAt, "ms from the hover to the meaning")
			.toBeGreaterThanOrEqual(MEANING_WAIT_MS);
	},
);

Then(
	"the visitor sees {string} drawn with {string} under it and {string} drawn with {string} under it",
	async (
		{ world, browser },
		first: string,
		firstPinyin: string,
		second: string,
		secondPinyin: string,
	) => {
		const page = await pageOf(world, browser, "visitor");
		for (const [text, pinyin] of [
			[first, firstPinyin],
			[second, secondPinyin],
		]) {
			const block = character(page, text ?? "");
			await expect
				.soft(block.locator(".study-char__pinyin"))
				.toHaveText(pinyin ?? "");
			// A drawn character is an SVG with its strokes in the box.
			await expect
				.soft(block.locator(".study-strokes svg path").first())
				.toBeAttached();
		}
	},
);

Then(
	"the visitor sees that {string} gives {string} its meaning and {string} its sound",
	async (
		{ world, browser },
		semantic: string,
		text: string,
		phonetic: string,
	) => {
		const page = await pageOf(world, browser, "visitor");
		const block = character(page, text);
		const part = (component: string) =>
			block.locator(".study-part", { hasText: component });
		await expect
			.soft(part(semantic).locator(".study-tag--meaning"))
			.toHaveText("meaning");
		await expect
			.soft(part(phonetic).locator(".study-tag--sound"))
			.toHaveText("sound");
	},
);

Then(
	"the visitor sees {string} and {string}, with no drawn characters",
	async ({ world, browser }, pinyin: string, meaning: string) => {
		const page = await pageOf(world, browser, "visitor");
		await expect
			.soft(tooltip(page).locator(".study-tip__pinyin"))
			.toHaveText(pinyin);
		await expect
			.soft(tooltip(page).locator(".study-tip__meaning"))
			.toContainText(meaning);
		await expect.soft(tooltip(page).locator(".study-char")).toHaveCount(0);
		await expect.soft(tooltip(page).locator("svg")).toHaveCount(0);
	},
);

When(
	/^the visitor hovers a word in the title of today's (\d+)(?:st|nd|rd|th) paper$/,
	async ({ world, browser }, n: string) => {
		const page = await pageOf(world, browser, "visitor");
		const paper = nthPaper(world, world.today, Number(n));
		const title = page
			.locator(`article.entry[id="${paper.id}"]`)
			.locator(".entry__title");
		const point = await centreOf(title, "Paper");
		await page.mouse.move(point.x, point.y);
		// One frame later: a tooltip, if one were coming, has had the move to start from.
		await page.evaluate(
			() => new Promise((done) => requestAnimationFrame(() => done(null))),
		);
	},
);

Then("no word tooltip opens", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "visitor");
	await expect.soft(tooltip(page)).toHaveCount(0);
});

When(
	"the visitor clicks {string} in the Chinese entry's title",
	async ({ world, browser }, text: string) => {
		const page = await pageOf(world, browser, "visitor");
		// The article itself is another site's: a stand-in answers.
		await page.route(chineseOf(world).entry.url, (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<title>The article</title>",
			}),
		);
		const point = await centreOf(chineseTitle(page, world), text);
		await page.mouse.click(point.x, point.y);
	},
);

Then("the Chinese entry's article opens", async ({ world, browser }) => {
	const page = await pageOf(world, browser, "visitor");
	await expect.soft(page).toHaveURL(chineseOf(world).entry.url);
});
