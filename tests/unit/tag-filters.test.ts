// @vitest-environment jsdom
// The tag, read and ad hoc chips against the entries they hide. jsdom lays nothing out; only what is hidden is tested.
import { afterEach, expect, test, vi } from "vitest";
import { createSender } from "../../site/page/owner.ts";
import { createTagBoard } from "../../site/page/tag-board.ts";
import type { Entry, ReadState } from "../../site/page/types.ts";

const ENTRIES: Entry[] = [
	{ id: "arxiv:1", type: "paper", title: "One" },
	{ id: "arxiv:2", type: "paper", title: "Two", ad_hoc: true },
	{ id: "arxiv:3", type: "paper", title: "Three" },
	{ id: "arxiv:4", type: "paper", title: "Four" },
];

// The real tag board over four papers in one day: 1 and 2 are To read, 2 and 3 Learn first, 2 is ad hoc and read to
// the paper, 1 to the abstract.
function boardOverEntries() {
	const main = document.createElement("main");
	const contents = document.createElement("details");
	const date = document.createElement("p");
	date.className = "contents__date";
	const label = document.createElement("h4");
	const list = document.createElement("ul");
	contents.append(date, label, list);
	for (const entry of ENTRIES) {
		const article = document.createElement("article");
		article.className = "entry";
		article.id = entry.id;
		main.append(article);
		const item = document.createElement("li");
		const link = document.createElement("a");
		link.setAttribute("href", `#${entry.id}`);
		item.append(link);
		list.append(item);
	}
	const newestSection = document.createElement("section");
	document.body.append(main, contents);
	const readState: ReadState = {
		"arxiv:1": { depth: "abstract", date: null },
		"arxiv:2": { depth: "paper", date: null },
	};
	const board = createTagBoard(
		() => ENTRIES,
		readState,
		{
			"arxiv:1": { toRead: true },
			"arxiv:2": { toRead: true, learnFirst: true },
			"arxiv:3": { learnFirst: true },
		},
		createSender(),
		() => {},
	);
	board.start({
		main: main,
		newest: { date: "2026-11-17", entries: ENTRIES },
		newestSection: newestSection,
		older: [],
		contents: contents,
		onFilter: () => {},
	});
	const [tagRow, readRow] = board.chips;
	if (tagRow === undefined || readRow === undefined)
		throw new Error("the board has no chip rows");
	const [toRead, learnFirst, adHoc] = [...tagRow.children] as HTMLElement[];
	const [unread, abstract, paper] = [...readRow.children] as HTMLElement[];
	if (!toRead || !learnFirst || !adHoc || !unread || !abstract || !paper)
		throw new Error("a chip is missing");
	// The ids of the entries on show, and the chips that are pressed.
	const shown = () =>
		[...main.querySelectorAll<HTMLElement>("article")]
			.filter((article) => !article.hidden)
			.map((article) => article.id);
	const pressed = () =>
		[...tagRow.children, ...readRow.children]
			.filter((chip) => chip.getAttribute("aria-pressed") === "true")
			.map((chip) => chip.getAttribute("aria-label")?.split(" (")[0]);
	return {
		board,
		toRead,
		learnFirst,
		adHoc,
		unread,
		abstract,
		paper,
		shown,
		pressed,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test("tag chips show only entries with every pressed tag, read chips go on one at a time, and clearing shows every entry", () => {
	const page = boardOverEntries();
	expect(page.shown()).toEqual(["arxiv:1", "arxiv:2", "arxiv:3", "arxiv:4"]);

	// A tag chip shows only the entries with that tag.
	page.toRead.click();
	expect(page.shown()).toEqual(["arxiv:1", "arxiv:2"]);
	expect(page.pressed()).toEqual(["To read"]);

	// Two tag chips show the entries with both.
	page.learnFirst.click();
	expect(page.shown()).toEqual(["arxiv:2"]);
	expect(page.pressed()).toEqual(["To read", "Learn first"]);

	// The ad hoc chip adds its own condition; pressing a tag chip again takes that tag off.
	page.adHoc.click();
	page.toRead.click();
	expect(page.shown()).toEqual(["arxiv:2"]);
	expect(page.pressed()).toEqual(["Learn first", "Ad hoc"]);

	// A read chip goes on alone: the next one takes it off.
	page.abstract.click();
	expect(page.shown()).toEqual([]);
	expect(page.pressed()).toEqual(["Learn first", "Ad hoc", "Abstract"]);
	page.paper.click();
	expect(page.shown()).toEqual(["arxiv:2"]);
	expect(page.pressed()).toEqual(["Learn first", "Ad hoc", "Paper"]);
	page.paper.click();
	expect(page.pressed()).toEqual(["Learn first", "Ad hoc"]);

	// Clearing puts every chip off and every entry back.
	page.board.clearFilters();
	expect(page.pressed()).toEqual([]);
	expect(page.shown()).toEqual(["arxiv:1", "arxiv:2", "arxiv:3", "arxiv:4"]);
});
