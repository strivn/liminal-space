// @vitest-environment jsdom
// Mentions in a comment: what holds that the reader can't see.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCommentBoard } from "../../site/page/comment-board.ts";
import {
	colourMentions,
	mentionSuggestion,
	suggestionChip,
} from "../../site/page/mention.ts";
import { createSender } from "../../site/page/owner.ts";
import { linkAddresses } from "../../site/page/typeset.ts";

// The real board with a comment box open and "what is this @" typed, on a touch screen or a mouse screen.
function boxWithAt(touchScreen: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: touchScreen && query === "(pointer: coarse)",
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	const board = createCommentBoard(
		{},
		createSender(),
		() => {},
		async () => true,
	);
	const article = document.createElement("article");
	const title = document.createElement("h3");
	article.append(title);
	document.body.append(article, board.sheet);
	const view = board.entryView(
		{ id: "arxiv:2601.00001", type: "paper", title: "A paper" },
		{ title: title, abstract: null },
	);
	board.attach(view, article);
	view.addButton.click();
	const box = board.sheet.querySelector("textarea");
	if (box === null) throw new Error("the sheet has no comment box");
	box.focus();
	box.value = "what is this @";
	box.setSelectionRange(box.value.length, box.value.length);
	box.dispatchEvent(new Event("input"));
	return { box, sheet: board.sheet };
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("the suggestion", () => {
	test("@Claude is suggested only when the @ starts the text or follows a space or a line break", () => {
		expect(mentionSuggestion("@", 1)).toBe("Claude");
		expect(mentionSuggestion("what is this @", 14)).toBe("Claude");
		expect(mentionSuggestion("what is this\n@", 14)).toBe("Claude");
		expect(mentionSuggestion("me@", 3)).toBeNull();
		expect(mentionSuggestion("what is this@", 13)).toBeNull();
	});
});

describe("the suggestion on a touch screen", () => {
	test("typing @, or @ and the start of Claude such as @Cl, offers an @Claude chip", () => {
		const chip = suggestionChip(mentionSuggestion("@", 1), () => {});
		expect(chip?.tagName).toBe("BUTTON");
		expect(chip?.textContent).toBe("@Claude");
		expect(
			suggestionChip(mentionSuggestion("@Cl", 3), () => {})?.textContent,
		).toBe("@Claude");
	});

	test("text after the @ that is not the start of Claude, such as @Cat, offers no chip", () => {
		expect(suggestionChip(mentionSuggestion("@Cat", 4), () => {})).toBeNull();
		expect(suggestionChip(null, () => {})).toBeNull();
	});

	test('a tap on the chip fills in "@Claude "', () => {
		const { box, sheet } = boxWithAt(true);
		const chip = sheet.querySelector<HTMLButtonElement>(
			".comment-editor__chip",
		);
		expect(chip?.textContent).toBe("@Claude");
		box.blur();
		chip?.click();
		expect(box.value).toBe("what is this @Claude ");
		expect(document.activeElement).toBe(box);
		expect(sheet.querySelector(".comment-editor__chip")).toBeNull();
	});

	test("on a screen with a mouse, typing @ shows no @Claude chip", () => {
		const { sheet } = boxWithAt(false);
		expect(sheet.querySelector(".comment-editor__chip")).toBeNull();
	});
});

describe("the mention's colour", () => {
	test("an @Claude inside a link is not coloured", () => {
		const comment = document.createElement("p");
		comment.textContent = "See https://example.com/@Claude, then @Claude.";
		// A saved comment is drawn the way comment-board.ts draws it: links first, then the mentions.
		linkAddresses(comment);
		colourMentions(comment);
		const link = comment.querySelector("a");
		expect(link?.textContent).toContain("@Claude");
		expect(link?.querySelector(".claude-mention")).toBeNull();
		const coloured = comment.querySelectorAll(".claude-mention");
		expect(coloured).toHaveLength(1);
		expect(coloured[0]?.closest("a")).toBeNull();
	});
});
