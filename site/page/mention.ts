// Mentions in a comment: the suggestion while typing "@", and the mentions a comment may make.

import { CLAUDE_MENTION } from "../../shared/owner-protocol.ts";
import { el } from "./dom.ts";
import { textNodesOutside } from "./typeset.ts";

// The mentions a comment can make, as they are written once completed.
export const MENTIONS = ["@Claude"] as const;

// The "@" word that ends at the caret, with the space or start of the comment before it left out.
const WORD_AT_CARET = /(?<![^\s])@[^\s@]*$/u;

// The "@" word just before `caret` and where it starts, or null when the caret is not at the end of one.
export function wordAtCaret(
	text: string,
	caret: number,
): { word: string; start: number } | null {
	const found = WORD_AT_CARET.exec(text.slice(0, caret));
	if (found === null) return null;
	return { word: found[0], start: found.index };
}

// The first mention `word` is the beginning of, in any letter case, and not already the whole of; null when none.
export function mentionFor(word: string): string | null {
	const typed = word.toLowerCase();
	for (const mention of MENTIONS) {
		if (mention.length > word.length && mention.toLowerCase().startsWith(typed))
			return mention;
	}
	return null;
}

// What to show after the caret to complete a mention, or null: the rest of the first mention the text just before
// `caret` starts, when that text begins with "@" after a space or the start of the comment.
export function mentionSuggestion(text: string, caret: number): string | null {
	const found = wordAtCaret(text, caret);
	if (found === null) return null;
	const mention = mentionFor(found.word);
	if (mention === null) return null;
	return mention.slice(found.word.length);
}

// Every "@Claude" that asks Claude, found with the same pattern the Worker asks by.
const CLAUDE_MENTIONS = new RegExp(CLAUDE_MENTION.source, "giu");

// `text` as strings and span.claude-mention nodes, one node for each "@Claude" in it, in Claude's orange.
export function mentionNodes(text: string): (string | HTMLElement)[] {
	const nodes: (string | HTMLElement)[] = [];
	let from = 0;
	for (const found of text.matchAll(CLAUDE_MENTIONS)) {
		nodes.push(text.slice(from, found.index));
		nodes.push(el("span", { class: "claude-mention" }, found[0]));
		from = found.index + found[0].length;
	}
	nodes.push(text.slice(from));
	return nodes.filter((node) => node !== "");
}

// Replace the "@" word before the box's caret with the mention it completes and a space.
export function acceptMention(box: HTMLTextAreaElement): void {
	const caret = box.selectionStart;
	const found = wordAtCaret(box.value, caret);
	if (found === null) return;
	const mention = mentionFor(found.word);
	if (mention === null) return;
	const completed = `${mention} `;
	box.value =
		box.value.slice(0, found.start) + completed + box.value.slice(caret);
	const at = found.start + completed.length;
	box.setSelectionRange(at, at);
	box.dispatchEvent(new Event("input"));
}

// A tap target under the comment box that fills in the suggestion, or null.
export function suggestionChip(
	suggestion: string | null,
	onAccept: () => void,
): HTMLButtonElement | null {
	if (suggestion === null) return null;
	const mention = MENTIONS.find((one) => one.endsWith(suggestion));
	const chip = el(
		"button",
		{ type: "button", class: "comment-editor__chip" },
		mention ?? suggestion,
	);
	// A press must not take focus from the box, or the keyboard drops before the tap lands.
	chip.addEventListener("pointerdown", (event) => event.preventDefault());
	chip.addEventListener("mousedown", (event) => event.preventDefault());
	chip.addEventListener("click", onAccept);
	return chip;
}

// Colour each "@Claude" in an element's text, except one inside a link or typeset math.
export function colourMentions(element: HTMLElement): void {
	for (const node of textNodesOutside(element, ".katex, a")) {
		const nodes = mentionNodes(node.data);
		if (nodes.every((part) => typeof part === "string")) continue;
		node.replaceWith(...nodes);
	}
}
