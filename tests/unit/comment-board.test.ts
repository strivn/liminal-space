// @vitest-environment jsdom
// The comment board's shared state (site/page/comment-board.ts): what a redraw keeps of a reply of Claude's.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CommentBoard,
	type CommentView,
	createCommentBoard,
} from "../../site/page/comment-board.ts";
import { createSender, UNREACHABLE } from "../../site/page/owner.ts";
import { PHONE_QUERY } from "../../site/page/phone.ts";
import type { AllComments } from "../../site/page/types.ts";

const ENTRY_ID = "arxiv:2601.00001";

// A thread on the whole entry: a question to Claude, and Claude's reply in Markdown.
const SAVED = {
	[ENTRY_ID]: [
		{
			id: "t1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [
				{
					id: "c1",
					text: "@Claude what is this?",
					created: "2026-11-17T01:00:00Z",
					edited: null,
					author: "owner",
				},
				{
					id: "c2",
					text: "A **long** answer.",
					created: "2026-11-17T01:01:00Z",
					edited: null,
					author: "claude",
				},
			],
		},
	],
};

// A ResizeObserver that never reports a change.
class StillObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

// The real board on a wide window, with the entry's cards drawn in its column.
function wideBoard(
	resizeObserver: new (callback: () => void) => StillObserver = StillObserver,
): {
	view: CommentView;
	drawAgain: () => void;
} {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query === "(min-width: 1386px)",
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.stubGlobal("ResizeObserver", resizeObserver);
	const board = createCommentBoard(
		structuredClone(SAVED),
		createSender(),
		() => {},
		async () => true,
	);
	const article = document.createElement("article");
	const title = document.createElement("h3");
	article.append(title);
	document.body.append(article);
	const view = board.entryView(
		{ id: ENTRY_ID, type: "paper", title: "A paper" },
		{ title: title, abstract: null },
	);
	board.attach(view, article);
	const drawAgain = () => board.drawIn(document.body);
	drawAgain();
	return { view, drawAgain };
}

// The reply's text box and its Show more button, as last drawn.
function reply(view: CommentView): { text: Element; fold: HTMLButtonElement } {
	const comments = view.column.querySelectorAll(".comment");
	const last = comments[comments.length - 1];
	if (last === undefined) throw new Error("no comment drawn");
	const text = last.querySelector(".comment__text");
	const fold = last.querySelector(".comment__actions button");
	if (text === null || !(fold instanceof HTMLButtonElement))
		throw new Error("the reply has no text or no fold button");
	return { text, fold };
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test("a saved reply from Claude shows as plain text first, then as formatted Markdown once the Markdown renderer loads", async () => {
	const { view } = wideBoard();
	expect(reply(view).text.querySelector("strong")).toBeNull();
	await vi.waitFor(() => {
		expect(reply(view).text.querySelector("strong")).not.toBeNull();
	});
});

test("a reply from Claude that the reader expanded with Show more stays expanded when the comments are drawn again", async () => {
	const { view, drawAgain } = wideBoard();
	// The renderer's own redraw comes first, so the redraw below is the board's.
	await vi.waitFor(() => {
		expect(reply(view).text.querySelector("strong")).not.toBeNull();
	});
	expect(reply(view).fold.getAttribute("aria-expanded")).toBe("false");
	reply(view).fold.click();
	drawAgain();
	const drawn = reply(view);
	expect(drawn.fold.getAttribute("aria-expanded")).toBe("true");
	expect(drawn.text.classList.contains("comment__text--folded")).toBe(false);
});

// ---- the comment flows: a real board in a page, with the owner routes stood in by a fetch that records each change ----

type Screen = "wide" | "narrow" | "phone";
const COLUMN_QUERY = "(min-width: 1386px)";
const OTHER_ID = "arxiv:2601.00002";
const ABSTRACT =
	"We probe the model. Then the model fails, so steering vectors fail.";

// One change the page posted to an owner route.
type Posted = { url: string; headers: unknown; body: unknown };
type Page = {
	board: CommentBoard;
	views: CommentView[];
	articles: HTMLElement[];
	posted: Posted[];
	notices: string[];
	answerWith: (status: number) => void;
	moveTo: (screen: Screen) => void;
};

const comment = (id: string, text: string) => ({
	id: id,
	text: text,
	created: "2026-09-27T16:20:00.000Z",
	edited: null,
});
const wholeThread = (
	id: string,
	...comments: ReturnType<typeof comment>[]
) => ({
	id: id,
	field: null,
	passage: null,
	occurrence: null,
	comments: comments,
});
const passageThread = (
	id: string,
	passage: string,
	occurrence: number,
	...comments: ReturnType<typeof comment>[]
) => ({
	id: id,
	field: "abstract",
	passage: passage,
	occurrence: occurrence,
	comments: comments,
});
const highlightOn = (id: string, passage: string, occurrence = 1) => ({
	...passageThread(id, passage, occurrence),
	highlight: true,
});

// A page with one article per id, each with a title and an abstract, and the board started on it.
function openPage(
	options: { saved?: AllComments; screen?: Screen; ids?: string[] } = {},
): Page {
	let screen: Screen = options.screen || "wide";
	const columnListeners: (() => void)[] = [];
	const holds = (query: string) => {
		if (query === COLUMN_QUERY) return screen === "wide";
		return (
			screen === "phone" &&
			(query === PHONE_QUERY || query === "(pointer: coarse)")
		);
	};
	vi.stubGlobal("matchMedia", (query: string) => ({
		get matches() {
			return holds(query);
		},
		media: query,
		addEventListener: (_type: string, listener: () => void) => {
			if (query === COLUMN_QUERY) columnListeners.push(listener);
		},
		removeEventListener: () => {},
	}));
	vi.stubGlobal("ResizeObserver", StillObserver);
	vi.stubGlobal("visualViewport", null);
	Object.defineProperty(document, "fonts", {
		value: { ready: Promise.resolve() },
		configurable: true,
	});
	const posted: Posted[] = [];
	let status = 200;
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		posted.push({
			url: url,
			headers: init.headers,
			body: JSON.parse(String(init.body)),
		});
		return new Response(null, { status: status });
	});
	const notices: string[] = [];
	const board = createCommentBoard(
		structuredClone(options.saved || {}),
		createSender(),
		(text) => notices.push(text),
		async () => true,
	);
	const main = document.createElement("main");
	document.body.append(main);
	const views: CommentView[] = [];
	const articles: HTMLElement[] = [];
	for (const id of options.ids || [ENTRY_ID]) {
		const article = document.createElement("article");
		article.className = "entry";
		const title = document.createElement("h3");
		title.className = "entry__title";
		title.textContent = "Sparse probes for deception";
		const abstract = document.createElement("p");
		abstract.className = "entry__abstract";
		abstract.textContent = ABSTRACT;
		article.append(title, abstract);
		main.append(article);
		const view = board.entryView(
			{ id: id, type: "paper", title: "Sparse probes for deception" },
			{ title: title, abstract: abstract },
		);
		article.append(view.column);
		board.attach(view, article);
		views.push(view);
		articles.push(article);
	}
	board.start();
	return {
		board,
		views,
		articles,
		posted,
		notices,
		answerWith: (next) => {
			status = next;
		},
		moveTo: (next) => {
			screen = next;
			for (const listener of columnListeners) listener();
		},
	};
}

// The comment box on show, in the column or in the side panel.
function box(page: Page, view: CommentView): HTMLTextAreaElement {
	const found =
		view.column.querySelector("textarea") ||
		page.board.sheet.querySelector("textarea");
	if (found === null) throw new Error("no comment box on show");
	return found;
}
function type(textarea: HTMLTextAreaElement, text: string) {
	textarea.value = text;
	textarea.dispatchEvent(new Event("input"));
}
function press(scope: Element, name: string): HTMLButtonElement {
	const found = Array.from(scope.querySelectorAll("button")).find(
		(button) => button.textContent?.trim() === name,
	);
	if (found === undefined) throw new Error(`no "${name}" button`);
	found.click();
	return found;
}
const saveBox = (textarea: HTMLTextAreaElement) =>
	textarea.form?.requestSubmit();
// Everything a card or panel shows as text, one string per comment card.
const cardTexts = (view: CommentView) =>
	Array.from(
		view.column.querySelectorAll(".comment__text"),
		(node) => node.textContent,
	);
// The changes posted so far, as the Worker would read them.
const changes = (page: Page) =>
	page.posted.map((one) => one.body as Record<string, unknown>);

// Select the `nth` appearance of `words` in an article's field, as a reader's drag does, and tell the page.
function select(
	article: HTMLElement,
	field: "title" | "abstract",
	words: string,
	nth = 1,
) {
	const element = article.querySelector(
		field === "title" ? ".entry__title" : ".entry__abstract",
	);
	const text = element?.firstChild;
	if (!(text instanceof Text))
		throw new Error("the field's text is drawn in marks");
	let at = -1;
	for (let found = 0; found < nth; found++)
		at = text.data.indexOf(words, at + 1);
	const range = document.createRange();
	range.setStart(text, at);
	range.setEnd(text, at + words.length);
	const selection = document.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
}
const floatButtons = () =>
	document.querySelector<HTMLElement>(".selection-float");

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
		this.dispatchEvent(new Event("close"));
	};
	// jsdom lays nothing out: every selection and highlight gets one empty box to be placed by.
	const box = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
	Range.prototype.getClientRects = () => [box] as unknown as DOMRectList;
	HTMLElement.prototype.getClientRects = () => [box] as unknown as DOMRectList;
	vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("writing a comment", () => {
	test("a comment on the whole entry shows as a card and is posted under the entry's id, without an author", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "Worth a reading group slot");
		saveBox(box(page, view));

		expect(cardTexts(view)).toEqual(["Worth a reading group slot"]);
		expect(view.article?.querySelector("mark")).toBeNull();
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		const posted = page.posted[0];
		expect(posted?.url).toBe("../api/owner/comments");
		expect(posted?.headers).toMatchObject({ "X-Liminal": "1" });
		const body = posted?.body as Record<string, unknown>;
		expect(body.entryId).toBe(ENTRY_ID);
		expect(body.thread).toMatchObject({
			field: null,
			passage: null,
			occurrence: null,
		});
		expect(body.delete).toEqual([]);
		const saved = body.save as Record<string, unknown>[];
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			text: "Worth a reading group slot",
			edited: null,
		});
		expect(saved[0]).not.toHaveProperty("author");
	});

	test("a comment added to a thread with a reply from Claude posts only the new comment, without an author", async () => {
		const claudes = { ...comment("c2", "An answer"), author: "claude" };
		const page = openPage({
			saved: {
				[ENTRY_ID]: [
					{
						...wholeThread("t1", comment("c1", "@Claude why?")),
						comments: [comment("c1", "@Claude why?"), claudes],
					},
				],
			},
		});
		const view = page.views[0] as CommentView;
		press(view.column, "Reply");
		type(box(page, view), "Thanks");
		saveBox(box(page, view));
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		const saved = changes(page)[0]?.save as Record<string, unknown>[];
		expect(saved.map((one) => one.text)).toEqual(["Thanks"]);
		expect(JSON.stringify(page.posted)).not.toContain('"author"');
	});

	test("an empty or blank comment can't be saved", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		const textarea = box(page, view);
		const save = view.column.querySelector<HTMLButtonElement>(
			".comment-editor__save",
		);
		expect(save?.disabled).toBe(true);
		type(textarea, "   ");
		expect(save?.disabled).toBe(true);
		saveBox(textarea);
		expect(page.posted).toHaveLength(0);
		expect(view.column.querySelector(".comment-thread")).toBeNull();
		type(textarea, "now words");
		expect(save?.disabled).toBe(false);
	});

	test("Cancel leaves no comment and posts nothing", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "draft");
		press(view.column, "Cancel");
		expect(view.column.children).toHaveLength(0);
		expect(view.draft).toBeNull();
		expect(page.posted).toHaveLength(0);
	});

	test.each([
		["Meta+Enter saves", { metaKey: true }, true],
		["Control+Enter saves", { ctrlKey: true }, true],
		["a bare Enter only adds a line", {}, false],
	])("in a comment box, %s", async (_name, modifiers, saves) => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		const textarea = box(page, view);
		type(textarea, "Worth a reading group slot");
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
				...modifiers,
			}),
		);
		if (saves) await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(cardTexts(view)).toEqual(
			saves ? ["Worth a reading group slot"] : [],
		);
	});

	test("Escape in a comment box cancels the comment and does not also close the side panel", () => {
		const page = openPage({ screen: "narrow" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		const textarea = box(page, view);
		type(textarea, "draft");
		const reachedPanel = vi.fn();
		page.board.sheet.addEventListener("keydown", reachedPanel);
		const pressed = new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		});
		textarea.dispatchEvent(pressed);
		expect(pressed.defaultPrevented).toBe(true);
		expect(reachedPanel).not.toHaveBeenCalled();
		expect(view.draft).toBeNull();
		expect(page.posted).toHaveLength(0);
	});

	test("security: a comment shows its text as written, with HTML as plain text, line breaks kept and web addresses as links", () => {
		const text = "Line one\n<b>not bold</b> https://example.com";
		const page = openPage({
			saved: { [ENTRY_ID]: [wholeThread("t1", comment("c1", text))] },
		});
		const shown = (page.views[0] as CommentView).column.querySelector(
			".comment__text",
		);
		expect(shown?.textContent).toBe(text);
		expect(shown?.querySelector("b")).toBeNull();
		const links = shown?.querySelectorAll("a") || [];
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("href")).toBe("https://example.com");
		expect(links[0]?.textContent).toBe("https://example.com");
	});
});

describe("a comment on a passage", () => {
	test("selecting words in an abstract offers Highlight and Comment, and a comment posts and marks that occurrence of the words", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		select(page.articles[0] as HTMLElement, "abstract", "the model", 2);
		const buttons = floatButtons();
		expect(buttons?.hidden).toBe(false);
		expect(
			Array.from(
				buttons?.querySelectorAll("button") || [],
				(b) => b.textContent,
			),
		).toEqual(["Highlight", "Comment"]);

		press(buttons as HTMLElement, "Comment");
		expect(buttons?.hidden).toBe(true);
		expect(document.getSelection()?.isCollapsed).toBe(true);
		type(box(page, view), "Which model?");
		saveBox(box(page, view));
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(changes(page)[0]?.thread).toMatchObject({
			field: "abstract",
			passage: "the model",
			occurrence: 2,
		});
		// Only the second "the model" is marked, after the draw that follows the save.
		const marks = Array.from(
			view.article?.querySelectorAll("mark.comment-mark") || [],
		);
		expect(marks.map((mark) => mark.textContent)).toEqual(["the model"]);
		expect(marks[0]?.previousSibling?.textContent).toBe(
			"We probe the model. Then ",
		);
	});

	test("a comment on words selected in a title is posted as a passage of the title", async () => {
		const page = openPage();
		select(page.articles[0] as HTMLElement, "title", "probes");
		press(floatButtons() as HTMLElement, "Comment");
		const view = page.views[0] as CommentView;
		type(box(page, view), "why");
		saveBox(box(page, view));
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(changes(page)[0]?.thread).toMatchObject({
			field: "title",
			passage: "probes",
			occurrence: 1,
		});
	});

	test("Highlight and Comment go away when the selection is cleared", () => {
		const page = openPage();
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		expect(floatButtons()?.hidden).toBe(false);
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
		expect(floatButtons()?.hidden).toBe(true);
	});

	test("Cancel after a passage comment leaves no highlight behind", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		press(floatButtons() as HTMLElement, "Comment");
		// While the box is open its passage is marked, as "new".
		expect(
			view.article?.querySelector('mark[data-thread="new"]'),
		).not.toBeNull();
		type(box(page, view), "draft");
		press(view.column, "Cancel");
		expect(view.article?.querySelector("mark")).toBeNull();
		expect(page.posted).toHaveLength(0);
	});

	test("a comment whose passage is no longer in the text shows 'Passage not found' and the quote, and nothing is highlighted", () => {
		const page = openPage({
			saved: {
				[ENTRY_ID]: [
					passageThread("t1", "words that are gone", 1, comment("c1", "A")),
				],
			},
		});
		const view = page.views[0] as CommentView;
		expect(view.article?.querySelector("mark")).toBeNull();
		const card = view.column.querySelector(".comment-thread");
		expect(card?.querySelector(".comment-thread__missing")?.textContent).toBe(
			"Passage not found",
		);
		expect(card?.querySelector("blockquote")?.textContent).toBe(
			"words that are gone",
		);
	});
});

describe("replies, edits and deletes", () => {
	const saved = () => ({
		[ENTRY_ID]: [wholeThread("t1", comment("c1", "Contradicts Table 3"))],
	});

	test("a reply shows under its thread, and only the reply is posted, with the thread's id", async () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		press(view.column, "Reply");
		type(box(page, view), "Table 4 too");
		saveBox(box(page, view));
		expect(cardTexts(view)).toEqual(["Contradicts Table 3", "Table 4 too"]);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		const body = changes(page)[0] as Record<string, unknown>;
		expect(body.thread).toMatchObject({ id: "t1" });
		expect((body.save as { text: string }[]).map((one) => one.text)).toEqual([
			"Table 4 too",
		]);
	});

	test("an edit keeps the created time, sets an edited time and marks the card edited", async () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		press(view.column, "Edit");
		expect(box(page, view).value).toBe("Contradicts Table 3");
		type(box(page, view), "Contradicts Table 4");
		saveBox(box(page, view));
		expect(cardTexts(view)).toEqual(["Contradicts Table 4"]);
		expect(view.column.querySelector(".comment__meta")?.textContent).toMatch(
			/· edited$/,
		);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		const edited = (
			(changes(page)[0] as Record<string, unknown>).save as Record<
				string,
				string
			>[]
		)[0];
		expect(edited?.created).toBe("2026-09-27T16:20:00.000Z");
		expect(Number.isNaN(Date.parse(String(edited?.edited)))).toBe(false);
	});

	test("editing a stored comment that carries an author posts the edit without the author, which the site would refuse", async () => {
		const stored = { ...comment("c1", "Contradicts Table 3"), author: "owner" };
		const page = openPage({
			saved: { [ENTRY_ID]: [{ ...wholeThread("t1"), comments: [stored] }] },
		});
		const view = page.views[0] as CommentView;
		press(view.column, "Edit");
		type(box(page, view), "Contradicts Table 4");
		saveBox(box(page, view));
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		const body = changes(page)[0] as Record<string, unknown>;
		const sent = (body.save as Record<string, unknown>[])[0];
		expect(sent).toMatchObject({ id: "c1", text: "Contradicts Table 4" });
		expect(sent).not.toHaveProperty("author");
	});

	test("cancelling an edit keeps the old text and posts nothing", () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		press(view.column, "Edit");
		type(box(page, view), "Contradicts Table 4");
		press(view.column, "Cancel");
		expect(cardTexts(view)).toEqual(["Contradicts Table 3"]);
		expect(
			view.column.querySelector(".comment__meta")?.textContent,
		).not.toContain("edited");
		expect(page.posted).toHaveLength(0);
	});

	test("deleting asks first, and declining keeps the comment and posts nothing", () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		vi.mocked(window.confirm).mockReturnValue(false);
		press(view.column, "Delete");
		expect(window.confirm).toHaveBeenCalledWith("Delete this comment?");
		expect(cardTexts(view)).toEqual(["Contradicts Table 3"]);
		expect(page.posted).toHaveLength(0);
	});

	test("deleting a reply posts only its id, and deleting a thread's first comment posts the ids of the whole thread", async () => {
		const thread = wholeThread(
			"t1",
			comment("c1", "A"),
			comment("c2", "B"),
			comment("c3", "C"),
		);
		const page = openPage({ saved: { [ENTRY_ID]: [thread] } });
		const view = page.views[0] as CommentView;
		const second = view.column.querySelectorAll(".comment")[1] as HTMLElement;
		press(second, "Delete");
		expect(window.confirm).toHaveBeenLastCalledWith("Delete this reply?");
		expect(cardTexts(view)).toEqual(["A", "C"]);
		press(view.column.querySelector(".comment") as HTMLElement, "Delete");
		expect(window.confirm).toHaveBeenLastCalledWith(
			"Delete this comment and its 1 reply?",
		);
		expect(view.column.querySelector(".comment-thread")).toBeNull();
		await vi.waitFor(() => expect(page.posted).toHaveLength(2));
		expect(changes(page).map((body) => body.delete)).toEqual([
			["c2"],
			["c1", "c3"],
		]);
	});

	test("a delete the site refuses puts the comment back and says so under it", async () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		page.answerWith(500);
		press(view.column, "Delete");
		expect(view.column.querySelector(".comment-thread")).toBeNull();
		await vi.waitFor(() =>
			expect(cardTexts(view)).toEqual(["Contradicts Table 3"]),
		);
		expect(
			view.column.querySelector(".comment__warning")?.textContent,
		).toContain(`Not deleted: ${UNREACHABLE}`);
	});

	test("a comment the site refuses stays with a 'Not saved' warning, and is sent again with the next save in its thread", async () => {
		const page = openPage({ saved: saved() });
		const view = page.views[0] as CommentView;
		page.answerWith(500);
		press(view.column, "Reply");
		type(box(page, view), "my reply");
		saveBox(box(page, view));
		await vi.waitFor(() =>
			expect(
				view.column.querySelector(".comment__warning")?.textContent,
			).toContain(`Not saved: ${UNREACHABLE}`),
		);
		expect(cardTexts(view)).toEqual(["Contradicts Table 3", "my reply"]);

		page.answerWith(200);
		press(view.column, "Reply");
		type(box(page, view), "second reply");
		saveBox(box(page, view));
		await vi.waitFor(() => expect(page.posted).toHaveLength(2));
		const second = (changes(page)[1] as Record<string, unknown>).save as {
			text: string;
		}[];
		expect(second.map((one) => one.text)).toEqual(["my reply", "second reply"]);
		await vi.waitFor(() =>
			expect(view.column.querySelector(".comment__warning")).toBeNull(),
		);
	});
});

describe("a comment being written is not lost", () => {
	test("opening another entry's comment box keeps the text in the first", () => {
		const page = openPage({ ids: [ENTRY_ID, OTHER_ID] });
		const [first, second] = page.views as [CommentView, CommentView];
		first.addButton.click();
		type(box(page, first), "half-written thought");
		second.addButton.click();
		expect(box(page, first).value).toBe("half-written thought");
		expect(box(page, second).value).toBe("");
	});

	test("starting a different comment on the same entry asks before dropping the text, and declining keeps it", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "half-written thought");
		vi.mocked(window.confirm).mockReturnValue(false);
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		press(floatButtons() as HTMLElement, "Comment");
		expect(window.confirm).toHaveBeenCalledWith(
			"Discard the comment you started?",
		);
		expect(box(page, view).value).toBe("half-written thought");
		expect(view.draft).toMatchObject({ kind: "new", passage: null });

		vi.mocked(window.confirm).mockReturnValue(true);
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		press(floatButtons() as HTMLElement, "Comment");
		expect(view.draft).toMatchObject({
			kind: "new",
			passage: "the model",
			text: "",
		});
	});

	test("a comment being written moves between the column and the side panel when the window crosses 1386 pixels wide", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "half-written thought");
		page.moveTo("narrow");
		expect(page.board.sheet.open).toBe(true);
		expect(page.board.sheet.querySelector("textarea")?.value).toBe(
			"half-written thought",
		);
		page.moveTo("wide");
		expect(page.board.sheet.open).toBe(false);
		expect(view.column.querySelector("textarea")?.value).toBe(
			"half-written thought",
		);
	});

	test("a reply to a thread another device deleted keeps its text as a comment on the entry", () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [wholeThread("t1", comment("c1", "A"))] },
		});
		const view = page.views[0] as CommentView;
		press(view.column, "Reply");
		type(box(page, view), "my reply");
		page.board.replace({});
		expect(view.column.querySelector(".comment-thread")).toBeNull();
		expect(view.draft).toMatchObject({
			kind: "new",
			field: null,
			text: "my reply",
		});
		expect(box(page, view).value).toBe("my reply");
	});

	test("a comment another device added shows when the site's state is read again, and the box keeps its text", () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "half-written thought");
		page.board.replace({
			[ENTRY_ID]: [wholeThread("t7", comment("c7", "From the phone"))],
		});
		expect(cardTexts(view)).toEqual(["From the phone"]);
		expect(box(page, view).value).toBe("half-written thought");
	});

	test("reading the site's state again keeps a comment the site never got", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		page.answerWith(500);
		view.addButton.click();
		type(box(page, view), "Worth a reading group slot");
		saveBox(box(page, view));
		await vi.waitFor(() =>
			expect(view.column.querySelector(".comment__warning")).not.toBeNull(),
		);
		page.board.replace({});
		expect(cardTexts(view)).toEqual(["Worth a reading group slot"]);
	});

	test("an entry whose saved comments are not a list of threads is skipped with a warning, and other entries still draw", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const page = openPage({
			ids: [ENTRY_ID, OTHER_ID],
			saved: {
				[ENTRY_ID]: { id: "t1", comments: [] },
				[OTHER_ID]: [wholeThread("t2", comment("c2", "Fine"))],
			},
		});
		expect(cardTexts(page.views[0] as CommentView)).toEqual([]);
		expect(cardTexts(page.views[1] as CommentView)).toEqual(["Fine"]);
		expect(warn).toHaveBeenCalled();
	});
});

// The first highlight drawn in an entry.
function markIn(view: CommentView): HTMLElement {
	const found = view.article?.querySelector<HTMLElement>("mark");
	if (found === null || found === undefined) throw new Error("no highlight");
	return found;
}

describe("highlights", () => {
	const marks = (view: CommentView) =>
		Array.from(
			view.article?.querySelectorAll("mark.comment-mark") || [],
			(mark) => mark.textContent,
		);

	test("Highlight marks the selected passage, adds no card, and posts a thread flagged as a highlight", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		select(page.articles[0] as HTMLElement, "abstract", "the model", 2);
		press(floatButtons() as HTMLElement, "Highlight");
		expect(marks(view)).toEqual(["the model"]);
		expect(view.column.children).toHaveLength(0);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(changes(page)[0]).toMatchObject({
			entryId: ENTRY_ID,
			thread: { field: "abstract", passage: "the model", occurrence: 2 },
			save: [],
			delete: [],
			highlight: true,
		});
	});

	test("a highlight the site refuses is taken off again, and the page says why", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		page.answerWith(500);
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		press(floatButtons() as HTMLElement, "Highlight");
		expect(marks(view)).toEqual(["the model"]);
		await vi.waitFor(() => expect(marks(view)).toEqual([]));
		expect(page.notices).toEqual([`Not saved: ${UNREACHABLE}`]);
	});

	test("a click on a highlight offers Comment and Remove highlight, and Remove takes it away without asking", async () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		const view = page.views[0] as CommentView;
		markIn(view).click();
		const menu = document.querySelector<HTMLElement>(
			".highlight-menu",
		) as HTMLElement;
		expect(menu.hidden).toBe(false);
		expect(
			Array.from(
				menu.querySelectorAll("button"),
				(button) => button.textContent,
			),
		).toEqual(["Comment", "Remove highlight"]);
		press(menu, "Remove highlight");
		expect(window.confirm).not.toHaveBeenCalled();
		expect(marks(view)).toEqual([]);
		expect(menu.hidden).toBe(true);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(changes(page)[0]).toMatchObject({
			thread: { id: "h1" },
			highlight: false,
		});
	});

	test("a highlight the site would not remove comes back at its place, and the page says why", async () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		const view = page.views[0] as CommentView;
		page.answerWith(500);
		markIn(view).click();
		press(
			document.querySelector(".highlight-menu") as HTMLElement,
			"Remove highlight",
		);
		expect(marks(view)).toEqual([]);
		await vi.waitFor(() =>
			expect(marks(view)).toEqual(["steering vectors fail"]),
		);
		expect(page.notices).toEqual([`Not removed: ${UNREACHABLE}`]);
	});

	test("Comment on a highlight makes a thread on the same passage, and deleting that comment leaves the highlight", async () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		const view = page.views[0] as CommentView;
		markIn(view).click();
		press(document.querySelector(".highlight-menu") as HTMLElement, "Comment");
		type(box(page, view), "Contradicts Table 3");
		saveBox(box(page, view));
		expect(cardTexts(view)).toEqual(["Contradicts Table 3"]);
		expect(marks(view)).toEqual(["steering vectors fail"]);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
		expect(changes(page)[0]).toMatchObject({ thread: { id: "h1" } });

		press(view.column, "Delete");
		expect(view.column.querySelector(".comment-thread")).toBeNull();
		expect(marks(view)).toEqual(["steering vectors fail"]);
	});

	test("cancelling a comment on a highlight keeps the highlight and shows no card", () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		const view = page.views[0] as CommentView;
		markIn(view).click();
		press(document.querySelector(".highlight-menu") as HTMLElement, "Comment");
		expect(view.column.querySelector(".comment-thread")).not.toBeNull();
		type(box(page, view), "draft");
		press(view.column, "Cancel");
		expect(marks(view)).toEqual(["steering vectors fail"]);
		expect(view.column.querySelector(".comment-thread")).toBeNull();
	});

	test("Escape closes the highlight menu and puts focus back on the highlight", () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		const mark = (page.views[0] as CommentView).article?.querySelector(
			"mark",
		) as HTMLElement;
		mark.click();
		const menu = document.querySelector<HTMLElement>(
			".highlight-menu",
		) as HTMLElement;
		menu.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		expect(menu.hidden).toBe(true);
		expect(document.activeElement).toBe(mark);
		// The mark takes focus only from the script: it gives its tab stop up when focus leaves.
		expect(mark.getAttribute("tabindex")).toBe("-1");
		mark.blur();
		expect(mark.hasAttribute("tabindex")).toBe(false);
	});

	test("a click outside the highlight menu closes it", () => {
		const page = openPage({
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		(page.views[0] as CommentView).article
			?.querySelector("mark")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		const menu = document.querySelector<HTMLElement>(
			".highlight-menu",
		) as HTMLElement;
		expect(menu.hidden).toBe(false);
		document.body.click();
		expect(menu.hidden).toBe(true);
	});

	test("a click on a comment's highlight puts focus on its card in the column, and opens the panel at it on a narrow window", () => {
		const saved = {
			[ENTRY_ID]: [
				passageThread("t1", "steering vectors fail", 1, comment("c1", "A")),
			],
		};
		const wide = openPage({ saved: saved });
		(wide.views[0] as CommentView).article
			?.querySelector<HTMLElement>("mark")
			?.click();
		expect((document.activeElement as HTMLElement).dataset.thread).toBe("t1");
		expect(wide.board.sheet.open).toBe(false);

		document.body.replaceChildren();
		const narrow = openPage({ saved: saved, screen: "narrow" });
		(narrow.views[0] as CommentView).article
			?.querySelector<HTMLElement>("mark")
			?.click();
		expect(narrow.board.sheet.open).toBe(true);
		expect((document.activeElement as HTMLElement).dataset.thread).toBe("t1");
	});

	test("on a narrow window a highlight's Comment opens the panel with a new comment box quoting the passage", () => {
		const page = openPage({
			screen: "narrow",
			saved: { [ENTRY_ID]: [highlightOn("h1", "steering vectors fail")] },
		});
		markIn(page.views[0] as CommentView).click();
		press(document.querySelector(".highlight-menu") as HTMLElement, "Comment");
		expect(page.board.sheet.open).toBe(true);
		expect(page.board.sheet.querySelector("blockquote")?.textContent).toBe(
			"steering vectors fail",
		);
		expect(page.board.sheet.querySelector("textarea")?.value).toBe("");
	});

	test("hovering or focusing a card darkens its own highlight only", () => {
		const page = openPage({
			saved: {
				[ENTRY_ID]: [
					passageThread("t1", "the model", 1, comment("c1", "A")),
					passageThread("t2", "steering vectors fail", 1, comment("c2", "B")),
				],
			},
		});
		const view = page.views[0] as CommentView;
		const active = () =>
			Array.from(
				view.article?.querySelectorAll("mark.comment-mark--active") || [],
				(mark) => (mark as HTMLElement).dataset.thread,
			);
		const first = view.column.querySelector(".comment-thread") as HTMLElement;
		first.dispatchEvent(new MouseEvent("mouseenter"));
		expect(active()).toEqual(["t1"]);
		first.dispatchEvent(new MouseEvent("mouseleave"));
		expect(active()).toEqual([]);
		first.dispatchEvent(new FocusEvent("focusin"));
		expect(active()).toEqual(["t1"]);
		first.dispatchEvent(new FocusEvent("focusout"));
		expect(active()).toEqual([]);
	});

	test("releasing a drag that selected words in a title does not follow the title's link", () => {
		const page = openPage();
		const title = page.articles[0]?.querySelector(
			".entry__title",
		) as HTMLElement;
		const link = document.createElement("a");
		link.href = "https://arxiv.org/abs/2601.00001";
		link.textContent = title.textContent;
		title.replaceChildren(link);
		const range = document.createRange();
		range.setStart(link.firstChild as Text, 0);
		range.setEnd(link.firstChild as Text, 6);
		document.getSelection()?.removeAllRanges();
		document.getSelection()?.addRange(range);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
	});
});

describe("the side panel and the phone sheet", () => {
	const THREADS = [
		passageThread(
			"t1",
			"steering vectors fail",
			1,
			comment("c1", "On a passage"),
		),
		wholeThread("t2", comment("c2", "On the whole entry")),
	];

	test("on a narrow window an entry shows a count of its comment threads instead of cards, and highlights are not counted", () => {
		const page = openPage({
			screen: "narrow",
			saved: { [ENTRY_ID]: [...THREADS, highlightOn("h1", "the model")] },
		});
		const view = page.views[0] as CommentView;
		expect(view.column.children).toHaveLength(0);
		expect(view.countButton.hidden).toBe(false);
		expect(view.countButton.textContent).toBe("2");
		expect(view.countButton.getAttribute("aria-label")).toBe("Comments: 2");

		const onlyHighlights = openPage({
			screen: "narrow",
			saved: { [OTHER_ID]: [highlightOn("h1", "the model")] },
			ids: [OTHER_ID],
		});
		expect((onlyHighlights.views[0] as CommentView).countButton.hidden).toBe(
			true,
		);
	});

	test("the comment count opens the panel with whole-entry comments first, then passage comments under their quotes", () => {
		const page = openPage({ screen: "narrow", saved: { [ENTRY_ID]: THREADS } });
		const view = page.views[0] as CommentView;
		view.countButton.click();
		expect(page.board.sheet.open).toBe(true);
		const cards = Array.from(
			page.board.sheet.querySelectorAll<HTMLElement>(".comment-thread"),
		);
		expect(cards.map((card) => card.dataset.thread)).toEqual(["t2", "t1"]);
		expect(cards[1]?.querySelector("blockquote")?.textContent).toBe(
			"steering vectors fail",
		);
		expect(cards[0]?.querySelector("blockquote")).toBeNull();
	});

	test("on a narrow window, Comment opens an empty comment box in focus, and Comment on a selection quotes the selected passage", () => {
		const page = openPage({ screen: "narrow" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		expect(page.board.sheet.open).toBe(true);
		expect(document.activeElement).toBe(box(page, view));
		expect(box(page, view).value).toBe("");
		press(page.board.sheet, "Cancel");

		select(
			page.articles[0] as HTMLElement,
			"abstract",
			"steering vectors fail",
		);
		press(floatButtons() as HTMLElement, "Comment");
		expect(
			page.board.sheet.querySelector(".comment-draft blockquote")?.textContent,
		).toBe("steering vectors fail");
	});

	test("the panel's × closes it, and Comment opens the same box again with its text", () => {
		const page = openPage({ screen: "narrow" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "half-written thought");
		page.board.sheet
			.querySelector<HTMLButtonElement>(".comment-panel__close")
			?.click();
		expect(page.board.sheet.open).toBe(false);
		expect(page.board.sheet.querySelector("textarea")).toBeNull();
		view.addButton.click();
		expect(window.confirm).not.toHaveBeenCalled();
		expect(box(page, view).value).toBe("half-written thought");
	});

	test("closing the sheet the way a swipe down does keeps the comment being written", () => {
		const page = openPage({ screen: "phone" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "half-written thought");
		page.board.dismissSheet();
		expect(page.board.sheet.open).toBe(false);
		expect(view.draft?.text).toBe("half-written thought");
	});

	test("only a phone's panel is a sheet, and its comment box takes focus without scrolling the page", () => {
		const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
		const desktop = openPage({ screen: "narrow" });
		(desktop.views[0] as CommentView).addButton.click();
		expect(desktop.board.sheet.classList.contains("comment-panel--sheet")).toBe(
			false,
		);
		expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });

		document.body.replaceChildren();
		const phone = openPage({ screen: "phone" });
		(phone.views[0] as CommentView).addButton.click();
		expect(phone.board.sheet.classList.contains("comment-panel--sheet")).toBe(
			true,
		);
		expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
	});

	test("on a phone, saving a comment closes the sheet", async () => {
		const page = openPage({ screen: "phone" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "Worth a reading group slot");
		saveBox(box(page, view));
		expect(page.board.sheet.open).toBe(false);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
	});

	test("on a narrow desktop window, saving leaves the panel open on the thread", () => {
		const page = openPage({ screen: "narrow" });
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "Worth a reading group slot");
		saveBox(box(page, view));
		expect(page.board.sheet.open).toBe(true);
		expect(page.board.sheet.querySelector(".comment__text")?.textContent).toBe(
			"Worth a reading group slot",
		);
		expect(view.countButton.textContent).toBe("1");
	});
});

describe("the buttons beside a selection", () => {
	test("with a mouse the buttons float just below the selection, and on a touch screen they sit in a bar", () => {
		const mouse = openPage();
		select(mouse.articles[0] as HTMLElement, "abstract", "the model");
		expect(floatButtons()?.classList.contains("selection-float--bar")).toBe(
			false,
		);
		expect(floatButtons()?.style.top).toBe("4px");

		document.body.replaceChildren();
		const touch = openPage({ screen: "phone" });
		select(touch.articles[0] as HTMLElement, "abstract", "the model");
		expect(floatButtons()?.classList.contains("selection-float--bar")).toBe(
			true,
		);
		expect(floatButtons()?.style.top).toBe("");
		expect(floatButtons()?.style.left).toBe("");
	});

	test("pressing a button does not clear the selection, with a mouse or a finger", () => {
		const page = openPage({ screen: "phone" });
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		const highlight = document.querySelector(".highlight-float") as HTMLElement;
		const mouseDown = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		highlight.dispatchEvent(mouseDown);
		expect(mouseDown.defaultPrevented).toBe(true);
		const touchDown = new PointerEvent("pointerdown", {
			pointerType: "touch",
			bubbles: true,
			cancelable: true,
		});
		highlight.dispatchEvent(touchDown);
		expect(touchDown.defaultPrevented).toBe(true);
		expect(document.getSelection()?.toString()).toBe("the model");
	});

	test("Highlight still takes the passage when the browser clears the selection between the touch and the click", async () => {
		const page = openPage({ screen: "phone" });
		const view = page.views[0] as CommentView;
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		const highlight = document.querySelector<HTMLElement>(
			".highlight-float",
		) as HTMLElement;
		highlight.dispatchEvent(
			new PointerEvent("pointerdown", {
				pointerType: "touch",
				bubbles: true,
				cancelable: true,
			}),
		);
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
		// The bar stays while the finger is down.
		expect(floatButtons()?.hidden).toBe(false);
		highlight.click();
		expect(
			Array.from(
				view.article?.querySelectorAll("mark") || [],
				(mark) => mark.textContent,
			),
		).toEqual(["the model"]);
		await vi.waitFor(() => expect(page.posted).toHaveLength(1));
	});

	test("after a cancelled touch on the bar, the bar goes away when the selection is cleared", () => {
		const page = openPage({ screen: "phone" });
		select(page.articles[0] as HTMLElement, "abstract", "the model");
		const bar = floatButtons() as HTMLElement;
		bar.dispatchEvent(
			new PointerEvent("pointerdown", {
				pointerType: "touch",
				bubbles: true,
				cancelable: true,
			}),
		);
		bar.dispatchEvent(
			new PointerEvent("pointercancel", {
				pointerType: "touch",
				bubbles: true,
			}),
		);
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
		expect(bar.hidden).toBe(true);
	});

	test("a selection in the byline, or one that runs from one entry into the next, offers no buttons", () => {
		const page = openPage({ ids: [ENTRY_ID, OTHER_ID] });
		const [first, second] = page.articles as [HTMLElement, HTMLElement];
		const byline = document.createElement("p");
		byline.className = "entry__authors";
		byline.textContent = "Ada Lovelace";
		first.prepend(byline);
		const across = (from: Node, fromAt: number, to: Node, toAt: number) => {
			const range = document.createRange();
			range.setStart(from, fromAt);
			range.setEnd(to, toAt);
			document.getSelection()?.removeAllRanges();
			document.getSelection()?.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));
		};
		across(byline.firstChild as Text, 0, byline.firstChild as Text, 3);
		expect(floatButtons()?.hidden).toBe(true);
		across(
			first.querySelector(".entry__abstract")?.firstChild as Text,
			0,
			second.querySelector(".entry__abstract")?.firstChild as Text,
			5,
		);
		expect(floatButtons()?.hidden).toBe(true);
	});
});

test("places the cards again when a card's height changes", async () => {
	const resized: (() => void)[] = [];
	const { view } = wideBoard(
		class extends StillObserver {
			constructor(callback: () => void) {
				super();
				resized.push(callback);
			}
		},
	);
	// The card as drawn last: the Markdown renderer draws it again.
	const card = () => view.column.querySelector<HTMLElement>(".comment-thread");
	await vi.waitFor(() => expect(card()?.style.top).toBe("0px"));
	// The title moves down, as when a card above it grows.
	const title = view.fields.title;
	title.getBoundingClientRect = () => new DOMRect(0, 40, 100, 26);
	for (const callback of resized) callback();
	expect(card()?.style.top).toBe("40px");
});
describe("folded threads", () => {
	// A question, Claude's answer, a follow-up and Claude's second answer: the middle two fold.
	const ASKED = {
		[ENTRY_ID]: [
			wholeThread(
				"t1",
				comment("c1", "@Claude what is the loss?"),
				comment("c2", "The sum of the errors."),
				comment("c3", "And the baseline?"),
				comment("c4", "It is in table 2."),
			),
		],
	};
	const FOLDED = ["@Claude what is the loss?", "It is in table 2."];
	const WHOLE = [
		"@Claude what is the loss?",
		"The sum of the errors.",
		"And the baseline?",
		"It is in table 2.",
	];
	const foldIcon = (scope: Element) =>
		scope.querySelector<HTMLButtonElement>('button[aria-label="Fold thread"]');

	test("a folded thread shows its first comment, the count of the hidden replies and its latest reply", () => {
		const page = openPage({ saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		expect(cardTexts(view)).toEqual(FOLDED);
		const card = view.column.querySelector(".comment-thread") as HTMLElement;
		expect(
			Array.from(card.children, (child) =>
				child.classList.contains("comment-thread__toggle")
					? child.textContent
					: child.querySelector(".comment__text")?.textContent,
			),
		).toEqual([FOLDED[0], "2 more replies", FOLDED[1]]);
		// Three comments or fewer hide nothing.
		const short = openPage({
			saved: {
				[ENTRY_ID]: [
					wholeThread(
						"t1",
						comment("c1", "A"),
						comment("c2", "B"),
						comment("c3", "C"),
					),
				],
			},
		});
		expect(cardTexts(short.views[0] as CommentView)).toEqual(["A", "B", "C"]);
	});

	test("every comment, the owner's too, shows 3 lines until Show more", () => {
		const page = openPage({ saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		const texts = view.column.querySelectorAll(".comment__text");
		expect(texts).toHaveLength(2);
		for (const text of texts)
			expect(text.classList.contains("comment__text--folded")).toBe(true);
		const first = view.column.querySelector(".comment") as HTMLElement;
		press(first, "Show more");
		expect(
			view.column
				.querySelector(".comment__text")
				?.classList.contains("comment__text--folded"),
		).toBe(false);
	});

	test("an open thread folds with an icon button named Fold thread", () => {
		const page = openPage({ saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		expect(foldIcon(view.column)).toBeNull();
		press(view.column, "2 more replies");
		const fold = foldIcon(view.column);
		expect(fold?.textContent).toBe("");
		expect(fold?.querySelector("svg")).not.toBeNull();
	});

	test("a thread the reader opened stays open when the comments are drawn again", () => {
		const page = openPage({ saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		press(view.column, "2 more replies");
		page.board.drawIn(document.body);
		expect(cardTexts(view)).toEqual(WHOLE);
	});

	test("a thread's fold button folds it until it is opened again", () => {
		const page = openPage({ saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		press(view.column, "2 more replies");
		foldIcon(view.column)?.click();
		page.board.drawIn(document.body);
		expect(cardTexts(view)).toEqual(FOLDED);
	});

	test("a thread the owner replies in opens", async () => {
		const page = openPage();
		const view = page.views[0] as CommentView;
		view.addButton.click();
		type(box(page, view), "@Claude what is the loss?");
		saveBox(box(page, view));
		const id = view.column.querySelector<HTMLElement>(".comment-thread")
			?.dataset.thread as string;
		await vi.waitFor(() => expect(page.posted.length).toBeGreaterThan(0));
		// The thread grows long with the site's state read again, once the save is done.
		const grown = structuredClone(ASKED);
		const thread = grown[ENTRY_ID]?.[0];
		if (thread) thread.id = id;
		await vi.waitFor(() => {
			page.board.replace(structuredClone(grown));
			expect(cardTexts(view)).toEqual(WHOLE);
		});
	});

	test("the count opens a folded thread in place in the side panel", () => {
		const page = openPage({ screen: "narrow", saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		view.countButton.click();
		const sheet = page.board.sheet;
		expect(sheet.querySelectorAll(".comment")).toHaveLength(2);
		press(sheet, "2 more replies");
		expect(sheet.open).toBe(true);
		expect(sheet.querySelectorAll(".comment")).toHaveLength(4);
	});

	test("the count opens a folded thread in place in the phone sheet", () => {
		const page = openPage({ screen: "phone", saved: structuredClone(ASKED) });
		const view = page.views[0] as CommentView;
		view.countButton.click();
		const sheet = page.board.sheet;
		expect(sheet.classList.contains("comment-panel--sheet")).toBe(true);
		press(sheet, "2 more replies");
		expect(sheet.open).toBe(true);
		expect(sheet.querySelectorAll(".comment")).toHaveLength(4);
	});
});
