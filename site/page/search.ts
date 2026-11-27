// The Search sentence: its blanks, what they match, and the choices each blank opens.
import type { SearchEntry } from "../../shared/site-data-shape.ts";
import { venueOf } from "../../shared/venue.ts";
import { el } from "./dom.ts";
import { PHONE_QUERY } from "./phone.ts";
import {
	type Blank,
	kindPanel,
	type PanelContext,
	readPanel,
	subjectPanel,
	timePanel,
	timeWord,
	venuePanel,
} from "./search-choices.ts";
import type { Thread } from "./types.ts";

// What the sentence says. `subjects` holds "t:<topic>", "f:<field>", "k:<keyword>" or "none"; `time` is "today",
// "week", "m:YYYY-MM" or "any"; `marks` is the owner's only.
export type Sentence = {
	kind: "all" | "paper" | "reading";
	subjects: string[];
	join: "or" | "and";
	venue: string;
	time: string;
	marks: {
		read: "unread" | "abstract" | "paper" | null;
		tags: string[];
		adHoc: boolean;
	};
};

// What the owner's marks are for an entry, as the read blank needs them.
export type EntryMarks = {
	read: "unread" | "abstract" | "paper";
	tags: string[];
	adHoc: boolean;
};

const DAY_MS = 86400000;

export function startingSentence(today: string): Sentence {
	return {
		kind: "all",
		subjects: [],
		join: "or",
		venue: "",
		time: `m:${today.slice(0, 7)}`,
		marks: { read: null, tags: [], adHoc: false },
	};
}

// Null marks: the public page.
export function matchesSentence(
	entry: SearchEntry,
	sentence: Sentence,
	today: string,
	marks: EntryMarks | null,
): boolean {
	return (
		matchesKind(entry, sentence.kind) &&
		matchesSubjects(entry, sentence) &&
		matchesVenue(entry, sentence.venue) &&
		matchesTime(entry, sentence.time, today) &&
		(marks === null || matchesMarks(entry, sentence.marks, marks))
	);
}

function matchesKind(entry: SearchEntry, kind: Sentence["kind"]): boolean {
	if (kind === "paper") return entry.type === "paper";
	if (kind === "reading") return entry.type !== "paper";
	return true;
}

// "none" means a paper without a topic.
function matchesSubjects(entry: SearchEntry, sentence: Sentence): boolean {
	if (sentence.subjects.length === 0) return true;
	const hits = sentence.subjects.map((subject) =>
		matchesSubject(entry, subject),
	);
	return sentence.join === "and" ? hits.every(Boolean) : hits.some(Boolean);
}

function matchesSubject(entry: SearchEntry, subject: string): boolean {
	if (subject === "none") return entry.type === "paper" && entry.topic === null;
	const value = subject.slice(2);
	if (subject.startsWith("t:")) return entry.topic?.name === value;
	if (subject.startsWith("f:")) return entry.topic?.field === value;
	if (subject.startsWith("k:")) return entry.keywords.includes(value);
	return false;
}

// "conference" or "conference|track".
function matchesVenue(entry: SearchEntry, venue: string): boolean {
	if (venue === "") return true;
	if (entry.venue === null) return false;
	const written = venueOf(entry.venue);
	const bar = venue.indexOf("|");
	if (bar === -1) return written.conference === venue;
	return (
		written.conference === venue.slice(0, bar) &&
		written.track === venue.slice(bar + 1)
	);
}

function matchesTime(entry: SearchEntry, time: string, today: string): boolean {
	if (time === "today") return entry.date === today;
	if (time === "week") {
		const first = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS);
		return (
			entry.date >= first.toISOString().slice(0, 10) && entry.date <= today
		);
	}
	if (time.startsWith("m:")) return entry.date.startsWith(time.slice(2));
	return time === "any";
}

function matchesMarks(
	entry: SearchEntry,
	wanted: Sentence["marks"],
	marks: EntryMarks,
): boolean {
	if (wanted.read !== null) {
		if (entry.type !== "paper" || marks.read !== wanted.read) return false;
	}
	if (!wanted.tags.every((tag) => marks.tags.includes(tag))) return false;
	return !wanted.adHoc || marks.adHoc;
}

// Any blank but time set.
export function isNarrowed(sentence: Sentence): boolean {
	return (
		sentence.kind !== "all" ||
		sentence.subjects.length > 0 ||
		sentence.venue !== "" ||
		sentence.marks.read !== null ||
		sentence.marks.tags.length > 0 ||
		sentence.marks.adHoc
	);
}

// `marksOf` is null on the public page.
export type SearchDeps = {
	entries: () => SearchEntry[];
	marksOf: ((id: string) => EntryMarks) | null;
	loadMonths: (months: string[]) => Promise<void>;
	onChange: (
		shown: Set<string>,
		narrowed: boolean,
		subjects: readonly string[],
	) => void;
};

// What createSearch hands the page.
export type Search = {
	focusOn: (subject: string) => void;
	reset: () => void;
	showDay: (date: string) => void;
	refresh: () => void;
};

const WIDE_QUERY = "(min-width: 1080px)";
// Quiet time before the count is spoken.
const COUNT_SPOKEN_AFTER_MS = 600;
// The wide panel's gap and widths.
const PANEL_MARGIN = 16;
const PANEL_WIDTH = 440;
const SUBJECT_PANEL_WIDTH = 520;

const BLANK_NAMES: Record<Blank, string> = {
	kind: "Kind",
	subject: "Subject",
	venue: "Venue",
	time: "Time",
	read: "Read",
};
const PANEL_TITLES: Record<Blank, string> = {
	kind: "Show me",
	subject: "about",
	venue: "from",
	time: "Time",
	read: "Your marks",
};
const KIND_WORDS: Record<Sentence["kind"], string> = {
	all: "everything",
	paper: "papers",
	reading: "news and articles",
};
const READ_WORDS = {
	unread: "unread",
	abstract: "abstract read",
	paper: "paper read",
};

function subjectPhrase(sentence: Sentence): string {
	if (sentence.subjects.length === 0) return "any subject";
	const phrases = sentence.subjects.map((subject) => {
		if (subject === "none") return "no topic yet";
		if (subject.startsWith("f:")) return `anything in ${subject.slice(2)}`;
		return subject.slice(2);
	});
	return phrases.join(sentence.join === "and" ? " and " : " or ");
}

function venuePhrase(venue: string): string {
	if (venue === "") return "any venue";
	const bar = venue.indexOf("|");
	if (bar === -1) return venue;
	const conference = venue.slice(0, bar);
	const track = venue.slice(bar + 1);
	return track === "" ? `${conference}, main track` : `${conference} ${track}`;
}

function readPhrase(marks: Sentence["marks"]): string {
	const parts: string[] = [];
	if (marks.read !== null) parts.push(READ_WORDS[marks.read]);
	for (const tag of marks.tags) parts.push(`tagged ${tag}`);
	if (marks.adHoc) parts.push("added ad hoc");
	return parts.length > 0 ? parts.join(" and ") : "read or not";
}

export function createSearch(
	root: HTMLElement,
	today: string,
	deps: SearchDeps,
): Search {
	const owner = deps.marksOf !== null;
	let sentence = startingSentence(today);
	let open: Blank | null = null;
	let typed = "";
	let drawWords: (() => void) | null = null;
	// Drops a load finished too late.
	let version = 0;
	let spoken: ReturnType<typeof setTimeout> | undefined;

	const live = el("p", { class: "visually-hidden", "aria-live": "polite" });
	const sentenceLine = el("p", { class: "search__sentence" });
	const tally = el("p", { class: "search__tally" });
	const backdrop = el("div", { class: "search__backdrop", hidden: "" });
	const panel = el("div", {
		class: "search__choices",
		id: "search-choices",
		hidden: "",
	});
	root.setAttribute("role", "search");
	root.setAttribute("aria-labelledby", "search-title");
	root.replaceChildren(
		el("p", { class: "search__title", id: "search-title" }, "Search"),
		sentenceLine,
		tally,
		live,
		backdrop,
		panel,
	);

	const isPhone = () => window.matchMedia(PHONE_QUERY).matches;
	const isWide = () => window.matchMedia(WIDE_QUERY).matches;
	const marksFor = (id: string) =>
		deps.marksOf === null ? null : deps.marksOf(id);

	function showing(of: Sentence): Set<string> {
		const ids = new Set<string>();
		for (const entry of deps.entries()) {
			if (matchesSentence(entry, of, today, marksFor(entry.id)))
				ids.add(entry.id);
		}
		return ids;
	}
	// Entries shown with `change` made.
	function countWith(change: Partial<Sentence>): number {
		return showing({ ...sentence, ...change }).size;
	}

	function blank(id: Blank, text: string, set: boolean, after = "") {
		const button = el(
			"button",
			{
				type: "button",
				class: set ? "search__blank search__blank--set" : "search__blank",
				"data-blank": id,
				"aria-label": `${BLANK_NAMES[id]}: ${text}`,
				"aria-expanded": String(open === id),
				"aria-controls": "search-choices",
			},
			text,
		);
		button.addEventListener("click", () => toggle(id));
		return el("span", { class: "search__nowrap" }, button, after);
	}

	function drawSentence() {
		const marks = sentence.marks;
		sentenceLine.replaceChildren(
			"Show me ",
			blank("kind", KIND_WORDS[sentence.kind], sentence.kind !== "all"),
			" about ",
			blank("subject", subjectPhrase(sentence), sentence.subjects.length > 0),
			" from ",
			blank("venue", venuePhrase(sentence.venue), sentence.venue !== "", ","),
			" ",
			blank("time", timeWord(sentence.time, today), true, owner ? "," : "."),
			...(owner
				? [
						" ",
						blank(
							"read",
							readPhrase(marks),
							marks.read !== null || marks.tags.length > 0 || marks.adHoc,
							".",
						),
					]
				: []),
		);
	}

	const sameAsStart = () =>
		JSON.stringify(sentence) === JSON.stringify(startingSentence(today));

	function drawTally() {
		const shown = showing(sentence).size;
		const parts: (Node | string)[] = [
			el(
				"span",
				null,
				el("b", null, String(shown)),
				` of ${deps.entries().length} entries`,
			),
		];
		if (!sameAsStart()) {
			const resetButton = el(
				"button",
				{ type: "button", class: "search__reset" },
				"Reset",
			);
			resetButton.addEventListener("click", reset);
			parts.push(resetButton);
		}
		tally.replaceChildren(...parts);
		clearTimeout(spoken);
		spoken = setTimeout(() => {
			live.textContent = `${shown} ${shown === 1 ? "entry" : "entries"}`;
		}, COUNT_SPOKEN_AFTER_MS);
	}

	function context(): PanelContext {
		return {
			sentence: sentence,
			entries: deps.entries(),
			today: today,
			get typed() {
				return typed;
			},
			count: countWith,
			pick: pick,
			type: type,
			done: () => toggle(null),
		};
	}

	function panelBody(blankId: Blank): Node[] {
		drawWords = null;
		if (blankId === "kind") return kindPanel(context());
		if (blankId === "time") return timePanel(context());
		if (blankId === "venue") return venuePanel(context());
		if (blankId === "read") return readPanel(context());
		const subjects = subjectPanel(context());
		drawWords = subjects.drawWords;
		return subjects.nodes;
	}

	function drawPanel() {
		const kept = document.activeElement;
		let keptKey: string | undefined;
		if (kept instanceof HTMLElement && panel.contains(kept))
			keptKey = kept.dataset.key;
		panel.hidden = open === null;
		backdrop.hidden = open === null;
		if (open === null) {
			panel.replaceChildren();
			return;
		}
		const named = root.querySelector(`[data-blank="${open}"]`);
		const title = el("p", {
			class: "search__choices-title",
			id: "search-choices-title",
		});
		title.append(`${PANEL_TITLES[open]} `);
		if (open !== "read" && named !== null)
			title.append(el("b", null, named.textContent ?? ""));
		const done = el(
			"button",
			{ type: "button", class: "search__done" },
			"Done",
		);
		done.addEventListener("click", () => toggle(null));
		const head = el(
			"div",
			{ class: "search__choices-head" },
			title,
			el(
				"span",
				{ class: "search__count" },
				el("b", null, String(countWith({}))),
				" entries",
			),
			done,
		);
		panel.replaceChildren(head, ...panelBody(open));
		panel.setAttribute("aria-labelledby", "search-choices-title");
		if (isPhone()) {
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-modal", "true");
		} else {
			panel.setAttribute("role", "region");
			panel.removeAttribute("aria-modal");
		}
		if (keptKey !== undefined) {
			[...panel.querySelectorAll<HTMLElement>("[data-key]")]
				.find((node) => node.dataset.key === keptKey)
				?.focus({ preventScroll: true });
		}
		place();
	}

	// Beside the sidebar, level with the sentence.
	function place() {
		if (open === null || !isWide()) return;
		const sidebar = root.closest(".sidebar") ?? root;
		const left = sidebar.getBoundingClientRect().right + PANEL_MARGIN;
		const wanted = open === "subject" ? SUBJECT_PANEL_WIDTH : PANEL_WIDTH;
		const top = Math.max(PANEL_MARGIN, root.getBoundingClientRect().top);
		panel.style.setProperty("--search-left", `${left}px`);
		panel.style.setProperty(
			"--search-width",
			`${Math.min(wanted, window.innerWidth - left - 24)}px`,
		);
		panel.style.setProperty("--search-top", `${top}px`);
		panel.style.setProperty(
			"--search-max",
			`${window.innerHeight - top - PANEL_MARGIN}px`,
		);
	}

	function focusInPanel() {
		const input = panel.querySelector<HTMLElement>(".search__box");
		const made = panel.querySelector<HTMLElement>(
			'[aria-pressed="true"], [aria-checked="true"]',
		);
		if (input !== null && !isPhone()) input.focus({ preventScroll: true });
		else
			(made ?? panel.querySelector<HTMLElement>(".search__done"))?.focus({
				preventScroll: true,
			});
	}

	function toggle(id: Blank | null) {
		const was = open;
		open = open === id ? null : id;
		typed = "";
		drawSentence();
		drawPanel();
		if (open !== null) focusInPanel();
		else if (was !== null) focusBlank(was);
	}

	function focusBlank(id: Blank) {
		root
			.querySelector<HTMLElement>(`[data-blank="${id}"]`)
			?.focus({ preventScroll: true });
	}

	function type(text: string) {
		typed = text;
		drawWords?.();
		place();
	}

	function pick(change: Partial<Sentence>, closes: boolean) {
		if (
			change.subjects !== undefined &&
			change.subjects.length > sentence.subjects.length
		)
			typed = "";
		sentence = { ...sentence, ...change };
		const was = open;
		if (closes) open = null;
		apply();
		if (closes && was !== null) focusBlank(was);
	}

	// Draw, tell the Feed, load months.
	function apply() {
		version += 1;
		const mine = version;
		drawSentence();
		drawTally();
		drawPanel();
		const shown = showing(sentence);
		deps.onChange(shown, isNarrowed(sentence), sentence.subjects);
		// Ad hoc is known once drawn.
		const wanted = sentence.marks.adHoc
			? showing({ ...sentence, marks: { ...sentence.marks, adHoc: false } })
			: shown;
		const months = new Set(
			deps
				.entries()
				.filter((entry) => wanted.has(entry.id))
				.map((entry) => entry.date.slice(0, 7)),
		);
		deps.loadMonths([...months]).then(
			() => {
				if (mine !== version || !sentence.marks.adHoc) return;
				deps.onChange(
					showing(sentence),
					isNarrowed(sentence),
					sentence.subjects,
				);
				refresh();
			},
			(error) => console.error("Months not loaded:", error),
		);
	}

	function focusOn(subject: string) {
		if (!sentence.subjects.includes(subject))
			sentence = { ...sentence, subjects: [...sentence.subjects, subject] };
		typed = "";
		open = null;
		apply();
	}

	function reset() {
		sentence = startingSentence(today);
		typed = "";
		open = null;
		apply();
	}

	function showDay(date: string) {
		sentence = { ...startingSentence(today), time: `m:${date.slice(0, 7)}` };
		typed = "";
		open = null;
		apply();
	}

	function refresh() {
		drawTally();
		if (open !== null) drawPanel();
	}

	document.addEventListener("keydown", (event) => {
		if (open === null) return;
		if (event.key === "Escape") {
			event.preventDefault();
			toggle(null);
			return;
		}
		if (event.key !== "Tab" || !isPhone()) return;
		const items = [
			...panel.querySelectorAll<HTMLElement>("button:not(:disabled), input"),
		];
		const first = items[0];
		const last = items[items.length - 1];
		if (first === undefined || last === undefined) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	});
	// The path outlives a redrawn button.
	document.addEventListener("focusin", (event) => {
		if (open === null || isPhone()) return;
		if (!event.composedPath().includes(root)) {
			open = null;
			drawSentence();
			drawPanel();
		}
	});
	document.addEventListener("click", (event) => {
		if (open === null) return;
		const path = event.composedPath();
		if (!path.includes(root) || path.includes(backdrop)) {
			open = null;
			drawSentence();
			drawPanel();
		}
	});
	window.addEventListener("resize", place);
	window.addEventListener("scroll", place, { passive: true });

	apply();
	return { focusOn, reset, showDay, refresh };
}

// Whether an entry holds a comment and a highlight, for the marks blank.
export type EntryNotes = { commented: boolean; highlighted: boolean };

export function notesOfThreads(threads: Thread[]): EntryNotes {
	throw new Error(`not implemented: ${threads.length}`);
}
