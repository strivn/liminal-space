// @vitest-environment jsdom
// An entry's read button against the read board, as render.ts wires them. jsdom lays nothing out; only the press is tested.
import { afterEach, expect, test, vi } from "vitest";
import { createCommentBoard } from "../../site/page/comment-board.ts";
import { renderEntry } from "../../site/page/entry.ts";
import { createFeedbackBoard } from "../../site/page/feedback-board.ts";
import { createSender } from "../../site/page/owner.ts";
import { createReadBoard } from "../../site/page/read-board.ts";
import { createStandoutBoard } from "../../site/page/standout-board.ts";
import { createTagBoard } from "../../site/page/tag-board.ts";
import { createTakeawayBoard } from "../../site/page/takeaway-board.ts";
import type { Entry, ReadState } from "../../site/page/types.ts";

const PAPER: Entry = {
	id: "arxiv:2601.00001",
	type: "paper",
	title: "A paper",
};

// The real boards and entry over one read state, with the site answering 200 to every change.
function pageWithPaper() {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
	const readState: ReadState = Object.create(null);
	const sender = createSender();
	const notice = () => {};
	const toggleViews: (() => void)[] = [];
	const readBoard = createReadBoard(
		readState,
		sender,
		notice,
		() => {
			for (const showPressed of toggleViews) showPressed();
		},
		() => {},
	);
	const article = renderEntry(PAPER, {
		readState: readState,
		onReadChange: (entry, depth) => readBoard.press(entry.id, depth),
		toggleViews: toggleViews,
		board: createCommentBoard({}, sender, notice, async () => true),
		tagBoard: createTagBoard(Object.create(null), sender, notice, () => {}),
		feedbackBoard: createFeedbackBoard(Object.create(null), sender, notice),
		standoutBoard: createStandoutBoard(Object.create(null), sender, notice),
		takeawayBoard: createTakeawayBoard(Object.create(null), sender),
	});
	document.body.append(article);
	return { readState, article };
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test("pressing an entry's Abstract button marks it read to the abstract, and a second press clears the mark", () => {
	const { readState, article } = pageWithPaper();
	const abstract = article.querySelector<HTMLButtonElement>(
		'button[data-depth="abstract"]',
	);
	if (abstract === null) throw new Error("the paper has no Abstract button");
	abstract.click();
	// A second toggle would clear the mark again.
	expect(readState[PAPER.id]).toMatchObject({ depth: "abstract" });
	expect(abstract.getAttribute("aria-pressed")).toBe("true");
	abstract.click();
	expect(readState[PAPER.id]).toBeUndefined();
	expect(abstract.getAttribute("aria-pressed")).toBe("false");
});
