// @vitest-environment jsdom
// Passages in a title (site/page/comments/passage.ts): what a selection offers to comment on, and highlights.
import { afterEach, expect, test } from "vitest";
import {
	selectedPassage,
	unwrapPassages,
	wrapPassage,
} from "../../site/page/comments/passage.ts";

// A title in the page, drawn from `html`.
function title(html: string): HTMLElement {
	const field = document.createElement("h3");
	field.className = "entry__title";
	field.innerHTML = html;
	document.body.append(field);
	return field;
}

// The page's selection, set from one point to another.
function select(
	startNode: Node,
	startOffset: number,
	endNode: Node,
	endOffset: number,
): Selection {
	const range = document.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	const selection = document.getSelection();
	if (selection === null) throw new Error("the page has no selection");
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

// The nth text node of an element.
function textNode(element: Element, n: number): Text {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	for (let i = 0; i < n; i += 1) node = walker.nextNode();
	if (!(node instanceof Text)) throw new Error(`no text node ${n}`);
	return node;
}

afterEach(() => {
	document.body.replaceChildren();
});

test("a selection in a title gives its words without the outer spaces, where they start, and which occurrence they are", () => {
	const field = title(
		"Learning to learn by <em>gradient</em> descent by gradient descent",
	);
	// " gradient" in the last text node, " descent by gradient descent": the space before it is selected too.
	const last = textNode(field, 2);
	const found = selectedPassage(select(last, 11, last, 20));
	if (found === null) throw new Error("the selection offers nothing");
	expect(found.field).toBe(field);
	expect(found.passage).toBe("gradient");
	expect(found.start).toBe(41);
	expect(found.occurrence).toBe(2);
});

test("a selection that crosses typeset math or runs out of the title offers nothing", () => {
	const field = title('Energy <span class="katex">E=mc^2</span> and mass');
	const outside = document.createElement("p");
	outside.textContent = "Below the title";
	document.body.append(outside);
	const first = textNode(field, 0);
	const last = textNode(field, 2);
	expect(selectedPassage(select(first, 0, last, 4))).toBeNull();
	expect(selectedPassage(select(last, 1, textNode(outside, 0), 5))).toBeNull();
});

test("a highlight across italic and plain text marks the whole passage, and removing it leaves the title as it was", () => {
	const html = "Learning to <em>learn</em> fast";
	const field = title(html);
	wrapPassage(field, 9, 17, "t1");
	const marks = field.querySelectorAll('mark.comment-mark[data-thread="t1"]');
	expect(Array.from(marks, (mark) => mark.textContent).join("")).toBe(
		"to learn",
	);
	unwrapPassages(field);
	expect(field.innerHTML).toBe(html);
});
