// An entry's study read against the text on the page: which word is at an offset, and where it is drawn.
import { isJsonObject } from "../../shared/narrow.ts";
import {
	type Study,
	type StudyPiece,
	type StudyWord,
	studyProblems,
} from "../../shared/study-protocol.ts";

export type Field = "title" | "description";

// The classes of the fields a study covers, which hold the entry's own title and description.
export const FIELD_CLASS: Record<Field, string> = {
	title: "entry__title",
	description: "entry__description",
};

export function isWord(piece: StudyPiece): piece is StudyWord {
	return "syllables" in piece;
}

// The text of a field as the page draws it.
export function fieldText(article: Element, field: Field): string {
	return article.querySelector(`.${FIELD_CLASS[field]}`)?.textContent ?? "";
}

// The study in `json`, or null when it is not this entry's study: its pieces must join back into the entry's own title
// and description.
export function readStudy(json: unknown, article: Element): Study | null {
	const entry = {
		id: article.id,
		title: fieldText(article, "title"),
		description: fieldText(article, "description"),
	};
	if (!isJsonObject(json) || studyProblems(json, entry).length > 0) return null;
	// studyProblems has checked every part of it.
	return json as Study;
}

// The word that covers `offset` in the text the pieces join to, with where it starts there; null in a gap.
export function wordAt(
	pieces: StudyPiece[],
	offset: number,
): { word: StudyWord; start: number } | null {
	let start = 0;
	for (const piece of pieces) {
		const end = start + piece.text.length;
		if (offset >= start && offset < end) {
			if (isWord(piece)) return { word: piece, start: start };
			return null;
		}
		start = end;
	}
	return null;
}

// The range over characters `start` to `end` of the field's text, found across its text nodes; null when the text is
// shorter.
export function rangeOf(
	field: Element,
	start: number,
	end: number,
): Range | null {
	const range = document.createRange();
	const nodes = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
	let position = 0;
	let started = false;
	for (let node = nodes.nextNode(); node !== null; node = nodes.nextNode()) {
		const length = node.nodeValue?.length ?? 0;
		if (!started && start < position + length) {
			range.setStart(node, start - position);
			started = true;
		}
		if (started && end <= position + length) {
			range.setEnd(node, end - position);
			return range;
		}
		position += length;
	}
	return null;
}

// Where `node` at `offset` is in the field's text.
export function offsetIn(
	field: Element,
	node: Node,
	offset: number,
): number | null {
	if (!field.contains(node) || node.nodeType !== Node.TEXT_NODE) return null;
	const nodes = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
	let position = 0;
	for (let at = nodes.nextNode(); at !== null; at = nodes.nextNode()) {
		if (at === node) return position + offset;
		position += at.nodeValue?.length ?? 0;
	}
	return null;
}

// The box of the range that holds the point (a word that wraps has one per line); null when none does.
export function boxAt(range: Range, x: number, y: number): DOMRect | null {
	for (const box of range.getClientRects()) {
		if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
			return box;
	}
	return null;
}
