// The shelf at the end of the newest day on the owner's page: the papers with no read mark that have waited longest.
import type { IndexDay } from "../../shared/site-data-shape.ts";
import type { MonthLoader } from "./data.ts";
import { DAY_MONTH } from "./days.ts";
import { el } from "./dom.ts";
import type { PageModel } from "./page-model.ts";
import type { Day, ReadState } from "./types.ts";
import { typeset } from "./typeset.ts";

// A paper waits this long before the shelf lists it; the shelf lists at most this many.
const WAITING_DAYS = 10;
const SHELF_SIZE = 10;

// A paper the shelf may list: its id, the day it appeared, its month's name in the index, and its title, null while
// its month isn't loaded.
export type ShelfPaper = {
	id: string;
	date: string;
	month: string;
	title: string | null;
};

// The papers the shelf lists: no read mark, appeared 10 or more days before `today`, oldest first, at most 10.
export function waitingPapers(
	papers: ShelfPaper[],
	state: ReadState,
	today: string,
): ShelfPaper[] {
	const end = new Date(`${today}T00:00:00Z`);
	end.setUTCDate(end.getUTCDate() - WAITING_DAYS);
	const latest = end.toISOString().slice(0, 10);
	const waiting = papers.filter(
		(paper) => state[paper.id] === undefined && paper.date <= latest,
	);
	// sort() is stable: papers of one day keep the order they were given in.
	waiting.sort((a, b) => a.date.localeCompare(b.date));
	return waiting.slice(0, SHELF_SIZE);
}

// The shelf's <aside>: a button, "Unread for 10 days or more · N", that folds and unfolds the list of each paper's
// title, linked to the paper, and " since <day>". It is a button, not a <details>, so the page's day rows stay
// the only <details> in the reading column. Papers whose title isn't loaded yet are left out until their month loads.
// `open` says whether the list shows; onToggle runs on a press.
export function shelfNode(
	papers: ShelfPaper[],
	open: boolean,
	onToggle: () => void,
): HTMLElement {
	const toggle = el(
		"button",
		{ type: "button", class: "shelf__title", "aria-expanded": String(open) },
		`Unread for 10 days or more · ${papers.length}`,
	);
	toggle.addEventListener("click", onToggle);
	const body = el("div", { class: "shelf__body" });
	body.hidden = !open;
	if (papers.length === 0) {
		body.append(
			el("p", { class: "shelf__empty" }, "Nothing has waited that long."),
		);
	} else {
		const items: HTMLElement[] = [];
		for (const paper of papers) {
			if (paper.title === null) continue;
			const link = el("a", { href: `#${paper.id}` }, paper.title);
			typeset(link);
			const since = DAY_MONTH.format(new Date(`${paper.date}T00:00:00Z`));
			items.push(el("li", null, link, ` since ${since}`));
		}
		body.append(el("ul", null, ...items));
	}
	return el("aside", { class: "shelf" }, toggle, body);
}

// What the shelf needs from the rest of the page: the index's older days, the read state, and the month loading.
export type ShelfDeps = {
	olderMonthDays: IndexDay[];
	readState: ReadState;
	loadMonth: MonthLoader;
	fillMonth: (month: string, monthLines: unknown[]) => void;
};

// The owner's page ends the newest day with the shelf: the unread papers that have waited longest, folded. A paper
// of a month not loaded has only its id and day from the index. Its month loads only once the shelf is opened, so
// opening the page loads no more than before; the shelf is drawn again when the month has loaded.
export function createShelf(model: PageModel, deps: ShelfDeps) {
	const indexDays = new Map(deps.olderMonthDays.map((day) => [day.date, day]));
	let shelf: HTMLElement | null = null;
	let shelfOpen = false;
	function shelfPapers() {
		const papers: ShelfPaper[] = [];
		const addDrawn = (day: Day) => {
			for (const entry of day.entries) {
				if (entry.type !== "paper") continue;
				papers.push({
					id: entry.id,
					date: day.date,
					month: day.date.slice(0, 7),
					title: entry.title,
				});
			}
		};
		addDrawn(model.newest);
		for (const pair of model.olderPairs) {
			const indexDay = indexDays.get(pair.day.date);
			if (pair.ids === null || indexDay === undefined) {
				addDrawn(pair.day);
				continue;
			}
			for (const entry of indexDay.entries) {
				if (entry.type !== "paper") continue;
				papers.push({
					id: entry.id,
					date: indexDay.date,
					month: indexDay.month,
					title: null,
				});
			}
		}
		return papers;
	}
	function drawShelf() {
		const waiting = waitingPapers(shelfPapers(), deps.readState, model.today);
		const node = shelfNode(waiting, shelfOpen, () => {
			shelfOpen = !shelfOpen;
			drawShelf();
		});
		if (shelf === null) model.newestSection.append(node);
		else shelf.replaceWith(node);
		shelf = node;
		if (shelfOpen) loadShelfMonths(waiting);
	}
	// Load the months holding the titles an open shelf still lacks; fillMonth draws their days and the shelf again.
	function loadShelfMonths(waiting: ShelfPaper[]) {
		const months = new Set<string>();
		for (const paper of waiting) {
			if (paper.title === null) months.add(paper.month);
		}
		for (const month of months) {
			deps
				.loadMonth(month)
				.then((monthLines) => deps.fillMonth(month, monthLines))
				.catch((error) =>
					console.error(`The shelf's ${month} not loaded:`, error),
				);
		}
	}
	return { drawShelf: drawShelf };
}
