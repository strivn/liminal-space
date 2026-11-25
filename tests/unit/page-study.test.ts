// @vitest-environment jsdom
// Word tooltips on Chinese entries (site/page/study.ts), run on the files scripts/deploy/build-site.ts builds. jsdom lays
// nothing out, so a stand-in gives every character a 10px box (the title's line at y 0, the description's at y 100) and
// answers the browser's caret and range questions from it.
import { execFileSync } from "node:child_process";
import path from "node:path";

// Hanzi Writer keeps the window's requestAnimationFrame as it is when it loads. This one steps by setTimeout, looked up
// at each call, so the test's clock moves the frames.
vi.hoisted(() => {
	globalThis.requestAnimationFrame = (callback) =>
		setTimeout(() => callback(performance.now()), 16) as unknown as number;
	globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
});

import HanziWriter from "hanzi-writer";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Study, StudyWord } from "../../shared/study-protocol.ts";
import { fieldText, wrapPassage } from "../../site/page/comments/passage.ts";
import { findPassage } from "../../site/page/comments.ts";
import { HOVER_QUERY, startStudy } from "../../site/page/study.ts";

const ENTRY = "url:https://example.com/news/1";
const PAPER = "arxiv:2611.00001";
const CHAR_WIDTH = 10;
const DESCRIPTION_TOP = 100;
const LINE_HEIGHT = 20;

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

const TITLE = "估值 410 OpenAI";
const DESCRIPTION = "贝佐斯忍住估。";
const STUDY: Study = {
	id: ENTRY,
	title: [word("估值", ["gū", "zhí"], "valuation"), { text: " 410 OpenAI" }],
	description: [
		word("贝佐斯", ["bèi", "zuǒ", "sī"], "Bezos", {
			meaningFrom: "model",
			name: true,
			inDictionary: false,
		}),
		word("忍住", ["rěn", "zhù"], "to bear", {
			meaningFrom: "model",
			inDictionary: false,
		}),
		word("估", ["gū"], "to estimate"),
		{ text: "。" },
	],
};

// The files the site builds for STUDY, by path under the page's folder.
let files: Map<string, string>;
let wordsFile: string;
beforeAll(() => {
	const built = execFileSync(
		process.execPath,
		[path.join(import.meta.dirname, "../support/study-files.ts")],
		{ input: `${JSON.stringify(STUDY)}\n`, maxBuffer: 1 << 24 },
	);
	files = new Map(Object.entries(JSON.parse(built.toString("utf8"))));
	const words = [...files.keys()].find((name) =>
		name.startsWith("study/words/"),
	);
	if (words === undefined) throw new Error("the build made no words file");
	wordsFile = words;
});

// What the page asked the site for, in order.
let asked: string[];
// The media queries that hold.
let media: Set<string>;
// The page's highlights by name.
let highlights: Map<string, { ranges: Range[] }>;

// The files the site doesn't answer for.
let missing: Set<string>;

async function fetchFile(path: string): Promise<unknown> {
	asked.push(path);
	const name = path.replace(/^\.\.\//, "");
	const text = missing.has(name) ? undefined : files.get(name);
	if (text === undefined) throw new Error(`${path} answered 404`);
	return JSON.parse(text);
}

// The index of a point of a field's text, counted over all its text nodes (comment marks split them).
function indexIn(field: Element, node: Node, offset: number): number {
	const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
	let count = 0;
	for (let at = walker.nextNode(); at !== null; at = walker.nextNode()) {
		if (at === node) return count + offset;
		count += at.nodeValue?.length ?? 0;
	}
	throw new Error("the point is not in the field");
}

function fieldBox(field: Element): { top: number } {
	return { top: field.closest(".entry__title") ? 0 : DESCRIPTION_TOP };
}

beforeEach(() => {
	asked = [];
	missing = new Set();
	media = new Set([HOVER_QUERY]);
	highlights = new Map();
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: media.has(query),
	}));
	vi.stubGlobal("CSS", { highlights: highlights });
	vi.stubGlobal(
		"Highlight",
		class {
			ranges: Range[];
			constructor(...ranges: Range[]) {
				this.ranges = ranges;
			}
		},
	);
	// The caret the browser puts at a point: the nearest gap between two characters.
	document.caretPositionFromPoint = (x: number, y: number) => {
		const field = document.querySelector(
			y < DESCRIPTION_TOP ? ".entry__title" : ".entry__description",
		);
		if (field === null) return null;
		const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
		let left = Math.round(x / CHAR_WIDTH);
		for (let at = walker.nextNode(); at !== null; at = walker.nextNode()) {
			const length = at.nodeValue?.length ?? 0;
			if (left <= length)
				return { offsetNode: at, offset: left } as CaretPosition;
			left -= length;
		}
		return null;
	};
	// The boxes of a range: one, from its first character to its last.
	Range.prototype.getClientRects = function (this: Range) {
		const field = (
			this.commonAncestorContainer instanceof Element
				? this.commonAncestorContainer
				: this.commonAncestorContainer.parentElement
		)?.closest(".entry__title, .entry__description");
		if (!field) return [] as unknown as DOMRectList;
		const top = fieldBox(field).top;
		return [
			{
				left:
					indexIn(field, this.startContainer, this.startOffset) * CHAR_WIDTH,
				right: indexIn(field, this.endContainer, this.endOffset) * CHAR_WIDTH,
				top: top,
				bottom: top + LINE_HEIGHT,
			},
		] as unknown as DOMRectList;
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	window.history.replaceState(null, "", "/");
});

// The page's entries: a studied one and a paper, and startStudy over them.
function mount(root = document.createElement("main")) {
	root.innerHTML = `
		<article class="entry" id="${ENTRY}"><div class="entry__body">
			<h3 class="entry__title"><a href="https://example.com/news/1">${TITLE}</a></h3>
			<div class="entry__description"><p>${DESCRIPTION}</p></div>
		</div></article>
		<article class="entry" id="${PAPER}"><div class="entry__body">
			<h3 class="entry__title"><a href="https://arxiv.org/abs/2611.00001">A paper</a></h3>
		</div></article>`;
	document.body.append(root);
	startStudy(root, new Map([[ENTRY, wordsFile]]), fetchFile);
	const article = root.querySelector<HTMLElement>(`[id="${ENTRY}"]`);
	const title = root.querySelector<HTMLElement>(".entry__title");
	const description = root.querySelector<HTMLElement>(".entry__description");
	const paperTitle = root.querySelector<HTMLElement>(
		`[id="${PAPER}"] .entry__title`,
	);
	if (!article || !title || !description || !paperTitle)
		throw new Error("the entries are not drawn");
	return { root, article, title, description, paperTitle };
}

// Move the mouse onto character `character` of a field, on its left half (the caret falls before it) or its right half
// (the caret falls after it); wait for what the move starts.
async function hover(
	field: HTMLElement,
	character: number,
	half: "left" | "right" = "left",
) {
	const x = character * CHAR_WIDTH + (half === "left" ? 2 : 8);
	const y = field.classList.contains("entry__title") ? 5 : DESCRIPTION_TOP + 5;
	const target = field.querySelector("a, p") ?? field;
	target.dispatchEvent(
		new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }),
	);
	await settle();
}

// The page's timers and animation frames on a clock the test moves; the rest of the event loop stays real, so a file
// is fetched and imported as in the page.
function useClock() {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "performance"],
	});
}

// Let everything that is waiting on a file, an import or a zero-length timer run.
async function settle() {
	for (let round = 0; round < 6; round += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(0);
	}
}

const tip = () => document.querySelector<HTMLElement>(".study-tip");
const meaning = () =>
	document.querySelector<HTMLElement>(".study-tip__meaning");
const boxes = () => [
	...document.querySelectorAll<HTMLElement>(".study-strokes"),
];

// Each Hanzi Writer's drawings: when each started and finished, on the test's clock.
function watchDrawings() {
	const drawings = new Map<object, { started: number[]; finished: number[] }>();
	const animate = HanziWriter.prototype.animateCharacter;
	vi.spyOn(HanziWriter.prototype, "animateCharacter").mockImplementation(
		function (this: HanziWriter, options) {
			let seen = drawings.get(this);
			if (seen === undefined) {
				seen = { started: [], finished: [] };
				drawings.set(this, seen);
			}
			const record = seen;
			record.started.push(performance.now());
			return animate.call(this, {
				...options,
				onComplete: (result) => {
					record.finished.push(performance.now());
					options?.onComplete?.(result);
				},
			});
		},
	);
	return () => [...drawings.values()];
}

test("hovering a word changes nothing in the entry's title or description, so comment marks stay as they were", async () => {
	useClock();
	const { article, title } = mount();
	wrapPassage(title, 0, 2, "t1");
	const before = article.outerHTML;
	await hover(title, 0);
	expect(tip()).not.toBeNull();
	expect(highlights.get("study-word")?.ranges).toHaveLength(1);
	expect(article.outerHTML).toBe(before);
});

test("a comment on a studied title still anchors to the words it quotes", async () => {
	useClock();
	const { title } = mount();
	const before = fieldText(title);
	const start = findPassage(before.text, "OpenAI", 1);
	wrapPassage(title, start, start + "OpenAI".length, "t1");
	await hover(title, 0);
	await hover(title, 1, "right");
	const after = fieldText(title);
	expect(after.text).toBe(before.text);
	expect(title.querySelector("mark.comment-mark")?.textContent).toBe("OpenAI");
	expect(findPassage(after.text, "OpenAI", 1)).toBe(start);
});

test("an entry's study file is fetched once, on the first hover of that entry", async () => {
	useClock();
	const { title, description, paperTitle } = mount();
	const wordsAsked = () => asked.filter((path) => path === wordsFile);
	expect(wordsAsked()).toEqual([]);
	await hover(paperTitle, 0);
	expect(wordsAsked()).toEqual([]);
	await hover(title, 0);
	await hover(description, 3);
	await hover(title, 0);
	expect(wordsAsked()).toEqual([wordsFile]);
});

test("numbers and Latin words get no tooltip", async () => {
	useClock();
	const { title } = mount();
	await hover(title, 0);
	expect(tip()).not.toBeNull();
	// "410" is characters 3 to 5 of the title and "OpenAI" 7 to 12.
	for (const character of [3, 5, 7, 12]) {
		await hover(title, character);
		expect(tip(), `character ${character}`).toBeNull();
	}
	await hover(title, 4, "right");
	expect(tip()).toBeNull();
});

test("a word's pinyin shows at once and its meaning one second after the hover", async () => {
	useClock();
	const { title } = mount();
	await hover(title, 0);
	expect(tip()?.querySelector(".study-tip__word")?.textContent).toBe("估值");
	expect(tip()?.querySelector(".study-tip__pinyin")?.textContent).toBe("gūzhí");
	expect(meaning()?.hasAttribute("data-waiting")).toBe(true);
	await vi.advanceTimersByTimeAsync(999);
	expect(meaning()?.hasAttribute("data-waiting")).toBe(true);
	await vi.advanceTimersByTimeAsync(1);
	expect(meaning()?.hasAttribute("data-waiting")).toBe(false);
	expect(meaning()?.textContent).toBe("valuation");
});

test("each character's strokes are drawn three times, two seconds apart", async () => {
	useClock();
	const drawings = watchDrawings();
	const { title } = mount();
	await hover(title, 0);
	await vi.advanceTimersByTimeAsync(60_000);
	// 估 and 值, each in its own box with its pinyin under it.
	expect(boxes()).toHaveLength(2);
	expect(
		[...document.querySelectorAll(".study-char__pinyin")].map(
			(label) => label.textContent,
		),
	).toEqual(["gū", "zhí"]);
	expect(drawings()).toHaveLength(2);
	for (const { started, finished } of drawings()) {
		expect(started).toHaveLength(3);
		expect(finished).toHaveLength(3);
		const gaps = [1, 2].map(
			(round) => (started[round] ?? 0) - (finished[round - 1] ?? 0),
		);
		expect(gaps).toEqual([2000, 2000]);
	}
});

test("with reduced motion the strokes show still until their box is clicked", async () => {
	useClock();
	media.add("(prefers-reduced-motion: reduce)");
	const drawings = watchDrawings();
	const { title } = mount();
	await hover(title, 0);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(boxes()).toHaveLength(2);
	for (const box of boxes()) expect(box.querySelector("svg")).not.toBeNull();
	expect(drawings()).toEqual([]);
	boxes()[0]?.click();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(drawings()).toHaveLength(1);
	expect(drawings()[0]?.started).toHaveLength(3);
});

test("a word not in the dictionary is marked in its tooltip, and a meaning from the model is labelled by Claude", async () => {
	useClock();
	const { description } = mount();
	const marks = () =>
		[...document.querySelectorAll(".study-tip__mark")].map(
			(mark) => mark.textContent,
		);
	// 忍住: not in the dictionary, its meaning from the model.
	await hover(description, 3);
	expect(marks()).toEqual(["Not in the dictionary"]);
	expect(meaning()?.querySelector(".study-tip__by")?.textContent).toBe(
		"by Claude",
	);
	expect(document.querySelectorAll(".study-char")).toHaveLength(2);
	// 贝佐斯: a name, kept whole, with no characters drawn.
	await hover(description, 0);
	expect(marks()).toEqual(["Name, written for its sound"]);
	expect(tip()?.querySelector(".study-tip__pinyin")?.textContent).toBe(
		"Bèizuǒsī",
	);
	expect(meaning()?.querySelector(".study-tip__by")).not.toBeNull();
	expect(document.querySelectorAll(".study-char")).toHaveLength(0);
	// 估: in the dictionary, its meaning the dictionary's.
	await hover(description, 5);
	expect(marks()).toEqual([]);
	expect(meaning()?.querySelector(".study-tip__by")).toBeNull();
});

test("Escape closes the tooltip", async () => {
	useClock();
	const { title } = mount();
	await hover(title, 0);
	expect(tip()).not.toBeNull();
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	expect(tip()).toBeNull();
	expect(highlights.has("study-word")).toBe(false);
});

test("on a touch screen no word tooltip opens", async () => {
	useClock();
	media.delete(HOVER_QUERY);
	const { title } = mount();
	await hover(title, 0);
	expect(tip()).toBeNull();
	expect(asked).toEqual([]);
	expect(highlights.size).toBe(0);
	expect(document.querySelector(".study-credits")).toBeNull();
});

test("a study file that does not load leaves the entry as it is", async () => {
	useClock();
	const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const { root, title } = mount();
	const before = root.innerHTML;
	missing.add(wordsFile);
	await hover(title, 0);
	await hover(title, 1);
	expect(tip()).toBeNull();
	expect(root.innerHTML).toBe(before);
	expect(asked.filter((path) => path === wordsFile)).toHaveLength(1);
	expect(warned).toHaveBeenCalled();
});

test("the owner's copy reads the study files from the site's own folder", async () => {
	useClock();
	window.history.pushState(null, "", "/liminal-space/owner/");
	const { title } = mount();
	await hover(title, 0);
	expect(asked.length).toBeGreaterThan(1);
	expect(asked.every((path) => path.startsWith("../study/"))).toBe(true);
	expect(asked).toContain(`../${wordsFile}`);
});

test("the page credits CC-CEDICT, Make Me a Hanzi and Arphic with links to their licences", () => {
	mount();
	const links = new Map(
		[...document.querySelectorAll(".study-credits a")].map((link) => [
			link.textContent,
			link.getAttribute("href"),
		]),
	);
	expect(links.get("CC-CEDICT")).toBe(
		"https://creativecommons.org/licenses/by-sa/4.0/",
	);
	expect(links.get("Make Me a Hanzi")).toBe(
		"study/licences/make-me-a-hanzi.txt",
	);
	expect(links.get("Arphic fonts")).toBe("study/licences/arphic.txt");
});

test("security: closing a tooltip removes its drawings without Hanzi Writer's destroy, which writes HTML", async () => {
	useClock();
	const { title } = mount();
	// destroy ends in an innerHTML write, which the page's Trusted Types refuse.
	const written = vi.spyOn(Element.prototype, "innerHTML", "set");
	await hover(title, 0);
	await vi.advanceTimersByTimeAsync(500);
	expect(boxes()).toHaveLength(2);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	expect(boxes()).toHaveLength(0);
	expect(written).not.toHaveBeenCalled();
	expect(document.querySelector("svg")).toBeNull();
});

test("a character's file is fetched once and shared by every word that uses the character", async () => {
	useClock();
	const { title, description } = mount();
	// 估值 draws 估, then the description's 估 is a word of its own.
	await hover(title, 0);
	await hover(description, 5);
	await hover(title, 0);
	const character = "study/chars/4f30.json";
	expect(asked.filter((path) => path === character)).toEqual([character]);
	expect(document.querySelectorAll(".study-char")).toHaveLength(2);
});

test("a closed tooltip leaves no stroke animation or timer running", async () => {
	useClock();
	const drawings = watchDrawings();
	const { title } = mount();
	await hover(title, 0);
	// Between two rounds: a drawing finished and the next one waits on its timer.
	await vi.advanceTimersByTimeAsync(3000);
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	const started = drawings().map((seen) => seen.started.length);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	await vi.advanceTimersByTimeAsync(0);
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(drawings().map((seen) => seen.started.length)).toEqual(started);
});
