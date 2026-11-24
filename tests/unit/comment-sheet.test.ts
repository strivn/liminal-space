// @vitest-environment jsdom
// The comment sheet on a phone (site/page/comment-board.ts): where focus goes after a comment is saved.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { focusAfterSave } from "../../site/page/comment-board.ts";

// An open sheet holding a comment box in focus, drawn as the board draws it.
let sheet: HTMLDialogElement;
let box: HTMLTextAreaElement;

beforeEach(() => {
	sheet = document.createElement("dialog");
	sheet.setAttribute("open", "");
	sheet.innerHTML =
		'<div class="comment-panel__inner" tabindex="-1">' +
		'<div class="comment-panel__head"><button class="comment-panel__close" aria-label="Close">×</button></div>' +
		'<div class="comment-panel__body"><textarea aria-label="Comment"></textarea></div></div>';
	document.body.append(sheet);
	box = sheet.querySelector("textarea") as HTMLTextAreaElement;
	box.focus();
});

afterEach(() => {
	sheet.remove();
});

// A save redraws the thread, which removes the focused comment box: focus falls back to the page.
function redrawWithoutTheBox() {
	box.remove();
	expect(document.activeElement).toBe(document.body);
}

describe("focus after saving", () => {
	test("saving a comment that asks @Claude keeps focus inside the sheet", () => {
		redrawWithoutTheBox();
		const target = focusAfterSave(sheet, true);
		expect(target).not.toBeNull();
		expect(sheet.contains(target)).toBe(true);
		target?.focus();
		expect(document.activeElement).toBe(target);
	});

	test("saving a comment without @Claude moves focus out of the sheet", () => {
		redrawWithoutTheBox();
		expect(focusAfterSave(sheet, false)).toBeNull();
		expect(sheet.contains(document.activeElement)).toBe(false);
	});
});

test.todo("the count opens a folded thread in place in the phone sheet");
