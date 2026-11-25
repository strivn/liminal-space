// The Selected view: topic labels and the picked topic's marked papers, each with its note.
import { hasText } from "../../shared/entry-checks.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import { OWNER_TEXT_CHARS } from "../../shared/owner-protocol.ts";
import { SHORT_MONTHS } from "./days.ts";
import { el } from "./dom.ts";
import { titleLinksOf } from "./entry.ts";
import { SELECTED_TEXT, VIEW_NAMES } from "./selected.ts";
import type { Entry } from "./types.ts";
import { linkAddresses, typeset } from "./typeset.ts";

// A marked paper: its entry, the day it was marked and its note.
export type MarkedPaper = { entry: Entry; date: string; note: string };

// One topic label and how many marked papers it holds.
export type TopicLabel = { label: string; count: number };

// What a paper is listed under: the name of its main OpenAlex topic, the first of its topics, or "No topic yet".
export function topicOf(entry: Entry): string {
	const openalex = entry.openalex;
	if (isJsonObject(openalex) && Array.isArray(openalex.topics)) {
		const main: unknown = openalex.topics[0];
		if (isJsonObject(main) && hasText(main.name)) return main.name;
	}
	return SELECTED_TEXT.noTopic;
}

// The labels of the marked papers' topics, each with its count: the largest first, a tie in name order, and "No topic
// yet" last.
export function topicLabels(papers: MarkedPaper[]): TopicLabel[] {
	const counts = new Map<string, number>();
	for (const paper of papers) {
		const topic = topicOf(paper.entry);
		counts.set(topic, (counts.get(topic) ?? 0) + 1);
	}
	const labels = [...counts].map(([label, count]) => ({
		label: label,
		count: count,
	}));
	return labels.sort(
		(a, b) =>
			Number(a.label === SELECTED_TEXT.noTopic) -
				Number(b.label === SELECTED_TEXT.noTopic) ||
			b.count - a.count ||
			a.label.localeCompare(b.label),
	);
}

// The marked papers, the newest mark first; papers marked on one day keep their order.
export function newestMarkFirst(papers: MarkedPaper[]): MarkedPaper[] {
	return papers.slice().sort((a, b) => b.date.localeCompare(a.date));
}

// "28 Sep".
function shortDay(date: string): string {
	const month = SHORT_MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
	return `${Number(date.slice(8))} ${month}`;
}

// The first two authors and a count of the rest, for a paper with more than three.
function authorsLine(authors: string[]): string {
	if (authors.length <= 3) return authors.join(", ");
	return `${authors.slice(0, 2).join(", ")} and ${authors.length - 2} others`;
}

// "authors · venue": a paper's venue, else where the digest took it from.
function metaOf(entry: Entry): string {
	const parts: string[] = [];
	if (entry.authors !== undefined && entry.authors.length > 0)
		parts.push(authorsLine(entry.authors));
	if (hasText(entry.venue)) parts.push(entry.venue);
	else if (hasText(entry.source)) parts.push(entry.source);
	return parts.join(" · ");
}

// Called with a paper's id and its note's new text when the owner leaves the note box.
export type NoteSaver = (id: string, note: string) => void;

// The note's card: a box to write in on the owner's copy (`saveNote`), the note as plain text on the public page, and
// nothing there for a note that is empty.
function noteCard(
	paper: MarkedPaper,
	position: number,
	saveNote: NoteSaver | null,
) {
	if (saveNote === null) {
		if (paper.note.trim() === "") return null;
		return el(
			"div",
			{ class: "note" },
			el("p", { class: "kicker" }, SELECTED_TEXT.note),
			el("p", { class: "standout__text" }, paper.note),
		);
	}
	const box = el("textarea", {
		class: "standout__note",
		id: `note-${position}`,
		rows: "2",
		maxlength: String(OWNER_TEXT_CHARS),
		placeholder: SELECTED_TEXT.addNote,
	});
	box.value = paper.note;
	box.addEventListener("change", () => {
		paper.note = box.value;
		saveNote(paper.entry.id, box.value);
	});
	return el(
		"div",
		{ class: "note" },
		el(
			"label",
			{ class: "kicker", for: `note-${position}` },
			SELECTED_TEXT.note,
		),
		box,
	);
}

// One marked paper: the day it was marked, its title, authors and venue, its abstract and its note.
function paperRow(
	paper: MarkedPaper,
	position: number,
	saveNote: NoteSaver | null,
) {
	const entry = paper.entry;
	const url = titleLinksOf(entry).title;
	let titleContent: string | HTMLElement = entry.title;
	if (url !== null) titleContent = el("a", { href: url }, entry.title);
	const title = el("h3", { class: "standout__title" }, titleContent);
	const text = [entry.abstract, entry.description].find(hasText);
	let abstract: HTMLElement | null = null;
	if (text !== undefined)
		abstract = el("p", { class: "standout__abstract" }, text);
	if (entry.type === "paper") {
		typeset(title);
		if (abstract !== null) typeset(abstract);
	}
	if (abstract !== null) linkAddresses(abstract);
	return el(
		"article",
		{ class: "standout" },
		el("p", { class: "standout__date" }, shortDay(paper.date)),
		el(
			"div",
			null,
			title,
			el("p", { class: "standout__meta" }, metaOf(entry)),
			abstract,
			noteCard(paper, position, saveNote),
		),
	);
}

// "Shaped my thinking", linking to Selected, in the public Feed's entry: in its kicker line, beside "Surprise" when it
// has one.
export function markKicker(article: HTMLElement): void {
	const link = el("a", { href: "#selected" }, SELECTED_TEXT.mark);
	const kicker = article.querySelector(".entry__kicker");
	if (kicker === null)
		article.prepend(el("p", { class: "entry__kicker" }, link));
	else kicker.append(" · ", link);
}

// What createSelectedView hands the rest of the page.
export type SelectedView = { draw: (papers: MarkedPaper[]) => void };

// The Selected view in `root`: its heading, a button for each topic label and the picked label's papers. The label
// picked stays while it still holds a paper; else the largest is picked. `saveNote` is the owner's: with it each paper
// has a note box, without it the note is text.
export function createSelectedView(
	root: HTMLElement,
	saveNote: NoteSaver | null,
): SelectedView {
	let picked: string | null = null;
	let shown: MarkedPaper[] = [];

	function draw(papers: MarkedPaper[]) {
		shown = newestMarkFirst(papers);
		const labels = topicLabels(shown);
		if (!labels.some((one) => one.label === picked))
			picked = labels[0]?.label ?? null;
		const buttons = labels.map((one) => {
			const button = el(
				"button",
				{
					type: "button",
					class: "label",
					"aria-pressed": String(one.label === picked),
				},
				one.label,
				el("span", { class: "label__n" }, String(one.count)),
			);
			button.addEventListener("click", () => {
				picked = one.label;
				draw(shown);
			});
			return button;
		});
		const rows = shown
			.filter((paper) => topicOf(paper.entry) === picked)
			.map((paper, position) => paperRow(paper, position, saveNote));
		root.replaceChildren(
			el("h2", null, VIEW_NAMES.selected),
			el(
				"div",
				{ class: "labels", role: "group", "aria-label": "Topic" },
				...buttons,
			),
			el("div", { class: "standouts" }, ...rows),
		);
	}

	return { draw: draw };
}
