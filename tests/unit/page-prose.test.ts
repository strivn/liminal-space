// @vitest-environment jsdom
// Prose formatting in an entry's text keeps comments working: a passage can be found and highlighted across the
// elements the formatting makes (site/page/typeset.ts, comments/passage.ts).
import { afterEach, expect, test } from "vitest";
import {
	selectedPassage,
	unwrapPassages,
	wrapPassage,
} from "../../site/page/comments/passage.ts";
import { renderEntry } from "../../site/page/entry.ts";
import { loadKatex, unloadKatex } from "./page-site.ts";

afterEach(() => {
	unloadKatex();
	document.body.replaceChildren();
});

// A paper whose abstract holds nested prose formatting, drawn for the public page.
function formattedAbstract() {
	loadKatex();
	const article = renderEntry(
		{
			id: "arxiv:2601.00001",
			type: "paper",
			title: "A paper",
			abstract: "A \\emph{useful \\textbf{result}}.",
		},
		null,
	);
	document.body.append(article);
	const abstract = article.querySelector<HTMLElement>(".entry__abstract");
	if (abstract === null) throw new Error("no abstract");
	return abstract;
}

test("nested TeX formatting becomes nested elements, and the abstract reads as plain text without the commands", () => {
	const abstract = formattedAbstract();
	expect(abstract.textContent).toBe("A useful result.");
	expect(abstract.querySelector("i strong, em strong, i b")).not.toBeNull();
});

test("a highlight across formatted words marks the whole passage, and removing it leaves the abstract as it was", () => {
	const abstract = formattedAbstract();
	const before = abstract.innerHTML;
	wrapPassage(abstract, 2, 15, "t1");
	const marks = abstract.querySelectorAll(
		'mark.comment-mark[data-thread="t1"]',
	);
	expect(Array.from(marks, (mark) => mark.textContent).join("")).toBe(
		"useful result",
	);
	unwrapPassages(abstract);
	expect(abstract.innerHTML).toBe(before);
});

test("a selection across formatted words gives the passage as plain text, where it starts, and which occurrence it is", () => {
	const abstract = formattedAbstract();
	const walker = document.createTreeWalker(abstract, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		if (node instanceof Text) nodes.push(node);
	const first = nodes.find((node) => node.data.includes("useful"));
	const last = nodes.find((node) => node.data.includes("result"));
	if (first === undefined || last === undefined) throw new Error("no text");
	const range = document.createRange();
	range.setStart(first, first.data.indexOf("useful"));
	range.setEnd(last, last.data.indexOf("result") + "result".length);
	const selection = document.getSelection();
	if (selection === null) throw new Error("no selection");
	selection.removeAllRanges();
	selection.addRange(range);
	const found = selectedPassage(selection);
	expect(found?.passage).toBe("useful result");
	expect(found?.start).toBe(2);
	expect(found?.occurrence).toBe(1);
});
