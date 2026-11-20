// @vitest-environment jsdom
// Returning to the reading place (site/page/reading-place.ts).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	PLACE_MAX_AGE_MS,
	parsePlace,
	placeScrollTop,
	readingPlace,
	refreshKeepingPlace,
	restoreReadingPlace,
	savePlace,
	startSavingPlace,
} from "../../site/page/reading-place.ts";

const BAR = 56;

// Where the page is scrolled to, which sets where every entry's box falls; jsdom lays nothing out.
const view = { scrollY: 0 };

// Entries three of 500px with 20px gaps, as they sit in the window at `scrollY`.
function entriesAt(scrollY: number) {
	return ["a", "b", "c"].map((id, index) => ({
		id: id,
		top: index * 520 - scrollY,
		bottom: index * 520 + 500 - scrollY,
	}));
}

// A <main> of article.entry elements, their boxes following `view`, and the window scrolled there.
function pageAt(scrollY: number, present = ["a", "b", "c"]) {
	view.scrollY = scrollY;
	const main = document.createElement("main");
	for (const id of present) {
		const article = document.createElement("article");
		article.className = "entry";
		article.id = id;
		article.getBoundingClientRect = () => {
			const box = entriesAt(view.scrollY).find((one) => one.id === id);
			if (box === undefined) throw new Error("no box");
			return {
				top: box.top,
				bottom: box.bottom,
				height: box.bottom - box.top,
			} as DOMRect;
		};
		main.append(article);
	}
	document.body.replaceChildren(main);
	Object.defineProperty(window, "scrollY", {
		value: scrollY,
		configurable: true,
	});
	return main;
}

function openedAs(navigationType: string) {
	Object.defineProperty(window, "navigation", {
		value: { activation: { navigationType: navigationType } },
		configurable: true,
	});
}

let scrolled: ReturnType<typeof vi.spyOn>;
let stopSaving: AbortController;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	stopSaving = new AbortController();
	scrolled = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
	stopSaving.abort();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// The reader scrolls the page to `scrollY` and the page is left; the next page is drawn at the top and opened as
// `navigationType`.
function readAt(scrollY: number) {
	vi.useFakeTimers();
	const main = pageAt(0);
	const keepPlace = startSavingPlace(main, () => BAR, stopSaving.signal);
	view.scrollY = scrollY;
	window.dispatchEvent(new Event("scroll"));
	vi.advanceTimersByTime(200);
	return keepPlace;
}

function comeBackAs(navigationType: string) {
	// The page lays out a little differently as it unloads.
	view.scrollY += 26;
	window.dispatchEvent(new Event("pagehide"));
	openedAs(navigationType);
	pageAt(0);
}

describe("the reading place", () => {
	test("the reading place is the entry at the top of the screen and how far into it the reader has scrolled", () => {
		// 700px down, entry "b" spans -180 to 320: the bar's edge at 56 is 236px into it.
		expect(readingPlace(entriesAt(700), BAR, 1)).toEqual({
			entryId: "b",
			offset: 236,
			savedAt: 1,
		});
		// With the header above the first entry, at the top of the page, the offset is negative.
		const belowHeader = [{ id: "a", top: 200, bottom: 700 }];
		expect(readingPlace(belowHeader, BAR, 1)).toEqual({
			entryId: "a",
			offset: BAR - 200,
			savedAt: 1,
		});
	});

	test("restoring a reading place scrolls the same point of its entry back under the bar, stopping at the top of the page", () => {
		const scrollY = 700;
		const saved = readingPlace(entriesAt(scrollY), BAR, 1);
		if (saved === null) throw new Error("no place");
		// Back at the top of a freshly drawn page, entry "b" sits at 520 in the window.
		expect(placeScrollTop(saved, 520, 0, BAR)).toBe(scrollY);
		// A place that would need a position above the page stops at the top.
		expect(placeScrollTop({ ...saved, offset: -144 }, 0, 0, BAR)).toBe(0);
	});

	test("coming back from a link restores the place", () => {
		readAt(700);
		comeBackAs("traverse");
		expect(restoreReadingPlace(BAR, false, Date.now())).toBe(true);
		expect(scrolled).toHaveBeenCalledWith(0, 700);
	});

	test("opening the app again restores the place", () => {
		readAt(700);
		comeBackAs("push");
		expect(restoreReadingPlace(BAR, false, Date.now())).toBe(true);
		expect(scrolled).toHaveBeenCalledWith(0, 700);
	});

	test("the Refresh button restores the place", () => {
		const keepPlace = readAt(700);
		const reload = vi.fn();
		refreshKeepingPlace(keepPlace, reload);
		expect(reload).toHaveBeenCalledOnce();
		comeBackAs("reload");
		expect(restoreReadingPlace(BAR, false, Date.now())).toBe(true);
		expect(scrolled).toHaveBeenCalledWith(0, 700);
	});

	test("a plain reload starts at the top", () => {
		readAt(700);
		comeBackAs("reload");
		expect(restoreReadingPlace(BAR, false, Date.now())).toBe(false);
		expect(scrolled).not.toHaveBeenCalled();
	});

	test("opening a permalink goes to its entry, not the saved place", () => {
		readAt(700);
		comeBackAs("navigate");
		expect(restoreReadingPlace(BAR, true, Date.now())).toBe(false);
		expect(scrolled).not.toHaveBeenCalled();
	});

	test("going Back restores the reading place even when the address holds an entry's permalink", () => {
		readAt(700);
		comeBackAs("traverse");
		expect(restoreReadingPlace(BAR, true, Date.now())).toBe(true);
		expect(scrolled).toHaveBeenCalledWith(0, 700);
	});

	test("a place older than 30 minutes is not restored", () => {
		readAt(700);
		comeBackAs("traverse");
		const later = Date.now() + PLACE_MAX_AGE_MS;
		expect(restoreReadingPlace(BAR, false, later + 1)).toBe(false);
		expect(restoreReadingPlace(BAR, false, later)).toBe(true);
	});

	test("a place on an entry no longer on the page is not restored", () => {
		savePlace(pageAt(700), BAR, Date.now());
		openedAs("traverse");
		pageAt(0, ["a", "c"]);
		expect(restoreReadingPlace(BAR, false, Date.now())).toBe(false);
		expect(scrolled).not.toHaveBeenCalled();
	});

	test("a saved reading place that is malformed or misses a field is ignored", () => {
		const good = { entryId: "b", offset: 156, savedAt: 1 };
		expect(parsePlace(JSON.stringify(good))).toEqual(good);
		const bad = [
			null,
			"not json",
			"null",
			"[]",
			JSON.stringify({ ...good, entryId: "" }),
			JSON.stringify({ ...good, entryId: 7 }),
			JSON.stringify({ ...good, offset: "156" }),
			JSON.stringify({ ...good, offset: null }),
			JSON.stringify({ ...good, savedAt: "now" }),
			'{"entryId":"b","offset":156}',
		];
		for (const raw of bad) expect(parsePlace(raw), String(raw)).toBeNull();
	});
});

test("with the browser's storage blocked, no place is restored and the page still starts", () => {
	pageAt(0);
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new DOMException("blocked", "SecurityError");
	});
	expect(restoreReadingPlace(BAR, false, Date.now())).toBe(false);
});
