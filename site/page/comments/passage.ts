// Passages in an entry's title and abstract: finding the selected one, and drawing and removing highlights.

import { mentionsClaude } from "../../../shared/owner-protocol.ts";
import { occurrenceOf } from "../comments.ts";
import { el } from "../dom.ts";
import type { SavedComment, Thread } from "../types.ts";
import { textNodesOutside } from "../typeset.ts";

// A selection a comment can be made on: which field, where the passage starts, its text and which appearance it is.
export type SelectedPassage = {
	field: Element;
	start: number;
	passage: string;
	occurrence: number;
	range: Range;
};

// A fresh id for a thread or a comment, unique enough for one person's notes.
export function newId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// The question to Claude a thread ends with: the owner's last comment, when it mentions @Claude (Claude hasn't answered
// it); otherwise null.
export function questionOf(thread: Thread): SavedComment | null {
	const last = thread.comments.at(-1);
	if (last === undefined) return null;
	if ((last.author || "owner") !== "owner") return null;
	if (!mentionsClaude(last.text)) return null;
	return last;
}

// The text comments anchor in: a field's text nodes outside typeset math, joined, with where each node starts in it.
// Math is left out because KaTeX writes each formula twice (MathML and HTML), so its text isn't what the reader sees.
export function fieldText(field: Element): {
	text: string;
	pieces: { node: Text; start: number }[];
} {
	const pieces: { node: Text; start: number }[] = [];
	let text = "";
	for (const node of textNodesOutside(field, ".katex")) {
		pieces.push({ node: node, start: text.length });
		text += node.data;
	}
	return { text: text, pieces: pieces };
}

// Where a point of a selection (a node and an offset in it) falls in fieldText's text.
function textOffset(
	field: Element,
	pieces: { node: Text; start: number }[],
	container: Node,
	offset: number,
) {
	const before = document.createRange();
	before.setStart(field, 0);
	before.setEnd(container, offset);
	let count = 0;
	for (const piece of pieces) {
		if (piece.node === container) return piece.start + offset;
		// Any other text node the range touches lies wholly before the point.
		if (before.intersectsNode(piece.node))
			count = piece.start + piece.node.data.length;
	}
	return count;
}

// The element (or a text node's parent) a selection point sits in.
function elementOf(node: Node) {
	if (node instanceof Element) return node;
	// Callers read .closest on the result.
	const parent = node.parentElement;
	if (parent === null) throw new Error("A selection point has no element");
	return parent;
}

// What a selection offers to comment on: { field, start, passage, occurrence, range }, or null. Only a selection
// wholly inside one title or abstract, outside typeset math, counts. Spaces at either end are left out, as a
// double-click on a word may take the space after it.
export function selectedPassage(
	selection: Selection | null,
): SelectedPassage | null {
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
		return null;
	const range = selection.getRangeAt(0);
	const field = elementOf(range.startContainer).closest(
		".entry__title, .entry__abstract",
	);
	if (
		!field ||
		elementOf(range.endContainer).closest(".entry__title, .entry__abstract") !==
			field
	)
		return null;
	for (const math of field.querySelectorAll(".katex")) {
		if (range.intersectsNode(math)) return null;
	}
	const whole = fieldText(field);
	let start = textOffset(
		field,
		whole.pieces,
		range.startContainer,
		range.startOffset,
	);
	let end = textOffset(
		field,
		whole.pieces,
		range.endContainer,
		range.endOffset,
	);
	// charAt gives the same character as whole.text[i], typed as text.
	while (start < end && /\s/.test(whole.text.charAt(start))) start += 1;
	while (end > start && /\s/.test(whole.text.charAt(end - 1))) end -= 1;
	if (start === end) return null;
	const passage = whole.text.slice(start, end);
	return {
		field: field,
		start: start,
		passage: passage,
		occurrence: occurrenceOf(whole.text, passage, start),
		range: range,
	};
}

// Highlight characters start..end of a field's text: each text node part in that span goes into a <mark>.
export function wrapPassage(
	field: Element,
	start: number,
	end: number,
	threadId: string,
): void {
	for (const piece of fieldText(field).pieces) {
		const length = piece.node.data.length;
		if (piece.start >= end || piece.start + length <= start) continue;
		const from = Math.max(start - piece.start, 0);
		const to = Math.min(end - piece.start, length);
		// splitText cuts a text node in two and returns the second half, like s[:to] and s[to:].
		let target = piece.node;
		if (to < length) target.splitText(to);
		if (from > 0) target = target.splitText(from);
		const mark = el("mark", { class: "comment-mark", "data-thread": threadId });
		target.replaceWith(mark);
		mark.append(target);
	}
}

// Take a field's highlights out again, joining the text nodes they split.
export function unwrapPassages(field: Element): void {
	const marks = field.querySelectorAll("mark.comment-mark");
	if (marks.length === 0) return;
	for (const mark of marks) mark.replaceWith(...mark.childNodes);
	field.normalize();
}

// Which field a highlight's thread is in, from its element.
export function fieldName(field: Element): "title" | "abstract" {
	if (field.classList.contains("entry__title")) return "title";
	return "abstract";
}
