// Word tooltips on Chinese entries, for a mouse only.
import { isJsonObject } from "../../shared/narrow.ts";
import { type CharFile, charFilePath } from "../../shared/site-data-shape.ts";
import type { Study } from "../../shared/study-protocol.ts";
import { siteFile } from "./data.ts";
import { el } from "./dom.ts";
import { createTooltip, type Tooltip } from "./study-tooltip.ts";
import {
	boxAt,
	FIELD_CLASS,
	type Field,
	offsetIn,
	rangeOf,
	readStudy,
	wordAt,
} from "./study-words.ts";

// The pointer the tooltips need.
export const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

// The name of the CSS highlight on the word under the pointer (style/study.css).
const HIGHLIGHT = "study-word";
const FIELDS: Field[] = ["title", "description"];

// What a character's file must hold to be drawn.
function isCharFile(json: unknown, character: string): json is CharFile {
	return (
		isJsonObject(json) &&
		json.character === character &&
		Array.isArray(json.parts)
	);
}

// Where the tooltips' data come from, each linked to its licence.
function creditsLine(): HTMLElement {
	const licence = (name: string, file: string) =>
		el("a", { href: siteFile(`study/licences/${file}`) }, name);
	return el(
		"p",
		{ class: "study-credits" },
		"Word meanings: ",
		el(
			"a",
			{ href: "https://creativecommons.org/licenses/by-sa/4.0/" },
			"CC-CEDICT",
		),
		" (CC BY-SA 4.0). Character parts and notes: ",
		licence("Make Me a Hanzi", "make-me-a-hanzi.txt"),
		" (LGPL-3.0). Strokes: ",
		licence("Arphic fonts", "arphic.txt"),
		", drawn with ",
		licence("Hanzi Writer", "hanzi-writer.txt"),
		" (MIT).",
	);
}

// The title or description under the pointer, and the entry it belongs to.
type Under = { article: Element; field: Element; kind: Field };

function fieldAt(target: EventTarget | null): Under | null {
	if (!(target instanceof Element)) return null;
	const article = target.closest("article.entry");
	if (article === null) return null;
	for (const kind of FIELDS) {
		const field = target.closest(`.${FIELD_CLASS[kind]}`);
		if (field !== null) return { article: article, field: field, kind: kind };
	}
	return null;
}

// The tooltip open, and the word it explains: where that word starts in its field's text.
type Shown = { field: Element; start: number; tip: Tooltip };

// Open a word's tooltip when the pointer rests on it in a studied entry under root, without changing the entry's
// text: the word under the pointer is found by its offset and shown with a CSS highlight. wordsFiles maps an entry's id
// to its words file, as data/index.json names it; fetchJson reads a file of the site's own.
export function startStudy(
	root: HTMLElement,
	wordsFiles: ReadonlyMap<string, string>,
	fetchJson: (path: string) => Promise<unknown>,
): void {
	if (wordsFiles.size === 0 || !window.matchMedia(HOVER_QUERY).matches) return;
	root.append(creditsLine());
	// Each entry's study and each character's file, fetched the first time and kept, a failure too.
	const studies = new Map<string, Promise<Study | null>>();
	const characters = new Map<string, Promise<CharFile | null>>();
	let shown: Shown | null = null;
	let latestMove = 0;

	function loadStudy(article: Element, path: string): Promise<Study | null> {
		let pending = studies.get(article.id);
		if (pending === undefined) {
			pending = fetchJson(siteFile(path)).then(
				(json) => readStudy(json, article),
				(error) => {
					console.warn("A study did not load:", error);
					return null;
				},
			);
			studies.set(article.id, pending);
		}
		return pending;
	}

	function charFile(character: string): Promise<CharFile | null> {
		let pending = characters.get(character);
		if (pending === undefined) {
			pending = fetchJson(siteFile(charFilePath(character))).then(
				(json) => (isCharFile(json, character) ? json : null),
				(error) => {
					console.warn("A character did not load:", error);
					return null;
				},
			);
			characters.set(character, pending);
		}
		return pending;
	}

	function close() {
		if (shown === null) return;
		shown.tip.close();
		shown = null;
		CSS.highlights.delete(HIGHLIGHT);
	}

	function open(under: Under, study: Study, x: number, y: number) {
		const { article, field, kind } = under;
		const caret = document.caretPositionFromPoint(x, y);
		const at = caret && offsetIn(field, caret.offsetNode, caret.offset);
		if (at === null || at === undefined) return close();
		// The caret sits between two characters: the pointer is on the one before it or the one after.
		for (const offset of [at, at - 1]) {
			const found = wordAt(study[kind], offset);
			if (found === null) continue;
			const range = rangeOf(
				field,
				found.start,
				found.start + found.word.text.length,
			);
			const line = range && boxAt(range, x, y);
			if (!range || !line) continue;
			if (shown?.field === field && shown.start === found.start) return;
			close();
			const tip = createTooltip(found.word, { charFile: charFile });
			tip.element.addEventListener("pointerleave", (event) => {
				const to = event.relatedTarget;
				if (!(to instanceof Node && root.contains(to))) close();
			});
			document.body.append(tip.element);
			const column = article.querySelector(".entry__body") ?? article;
			tip.place(line, column.getBoundingClientRect());
			CSS.highlights.set(HIGHLIGHT, new Highlight(range));
			shown = { field: field, start: found.start, tip: tip };
			return;
		}
		close();
	}

	root.addEventListener("pointermove", (event) => {
		if (!window.matchMedia(HOVER_QUERY).matches) return;
		const move = ++latestMove;
		const under = fieldAt(event.target);
		if (under === null) return close();
		const path = wordsFiles.get(under.article.id);
		if (path === undefined) return close();
		void loadStudy(under.article, path).then((study) => {
			if (move !== latestMove) return;
			if (study === null) return close();
			open(under, study, event.clientX, event.clientY);
		});
	});
	// The tooltip stays while the pointer is on it.
	root.addEventListener("pointerleave", (event) => {
		const to = event.relatedTarget;
		if (!(to instanceof Node && shown?.tip.element.contains(to))) close();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") close();
	});
}
