// The comments drawn in the page: highlights, cards in the column or the side panel, and the comment box. A passage
// highlighted without a comment is a thread with highlight true: underlined, with no card.

import { isJsonObject } from "../../shared/narrow.ts";
import {
	type AskRefusal,
	type CommentsChange,
	mentionsClaude,
	type ThreadPlace,
} from "../../shared/owner-protocol.ts";
import type { renderClaudeMarkdown } from "./claude-markdown.ts";
import { createAsks } from "./comments/ask.ts";
import { createCards } from "./comments/cards.ts";
import { createEditor } from "./comments/editor.ts";
import {
	fieldText,
	newId,
	questionOf,
	unwrapPassages,
	wrapPassage,
} from "./comments/passage.ts";
import { createPlacing } from "./comments/place.ts";
import { createSelection } from "./comments/selection.ts";
import {
	deleteQuestion,
	findPassage,
	findThread,
	removeComment,
	threadList,
	threadPlace,
	usableThreads,
} from "./comments.ts";
import { el } from "./dom.ts";
import { railButton } from "./icons.ts";
import { type Sender, UNREACHABLE } from "./owner.ts";
import { PHONE_QUERY } from "./phone.ts";
import { createPanel } from "./sheet.ts";
import { takeSiteState } from "./state.ts";
import type {
	AllComments,
	Entry,
	PassageAnchor,
	SavedComment,
	Thread,
	WholeAnchor,
} from "./types.ts";

// Comments live on the site, next to read state; never in the repo.
// At this width the comments get their own column right of the entries: 16 + 220 + 56 + 720 + 32 + 280 + 16.
const COMMENT_COLUMN_QUERY = "(min-width: 1386px)";
// A touch screen: Highlight and Comment sit in a bar at the bottom, clear of the browser's own menu by the selection.
const TOUCH_QUERY = "(pointer: coarse)";

// A new comment on the whole entry, before it is saved.
type WholeDraftAnchor = { field: null; passage: null; occurrence: null };
// The comment box open on an entry: a new comment, a reply to a thread, or an edit of one comment. `text` is what is
// typed so far; `focus` asks the next draw to focus the box.
export type Draft = (
	| ({ kind: "new" } & (PassageAnchor | WholeDraftAnchor))
	| { kind: "reply"; threadId: string }
	| { kind: "edit"; threadId: string; commentId: string }
) & { text: string; focus?: boolean };

// The two fields a comment can anchor in: an entry's title, and its abstract when it has one.
type CommentFields = { title: HTMLElement; abstract: HTMLElement | null };
// A card in the comment column, and the element it lines up with.
type Card = { node: HTMLElement; anchor: Element };
// One entry's comments in the page. `article` is set by attach, right after entryView builds the view.
export type CommentView = {
	entry: Entry;
	fields: CommentFields;
	article: HTMLElement | null;
	draft: Draft | null;
	cards: Card[];
	addButton: HTMLButtonElement;
	countButton: HTMLButtonElement;
	column: HTMLDivElement;
};
// A thread (or the new comment's box, with no thread) placed in an entry's text, for ordering the cards.
type PlacedCard = {
	thread: Thread | null;
	rank: number;
	start: number;
	missing: boolean;
};
// What createCommentBoard hands the rest of the page.
export type CommentBoard = {
	entryView: (entry: Entry, fields: CommentFields) => CommentView;
	attach: (view: CommentView, article: HTMLElement) => void;
	start: () => void;
	placeAll: () => void;
	drawIn: (container: Element) => void;
	replace: (fresh: AllComments) => void;
	// The side panel's dialog, the handle along its top on a phone, and closing it as its close button does.
	sheet: HTMLDialogElement;
	sheetHandle: HTMLElement;
	dismissSheet: () => void;
};
// Why a comment shows a warning ("Not saved: ...", "Not deleted: ..."), and the entry it is on.
type CommentWarning = { text: string; entryId: string };
// A comment a delete took from its thread, and its place (from 0) in the thread then.
type TakenComment = { comment: SavedComment; index: number };
// A thread's question to Claude as the page knows it: being answered (`text` is the reply so far, `done` once it ended
// and the saved reply is being read back), or refused, with the reason the thread shows.
export type Ask =
	| { kind: "answering"; text: string; done: boolean }
	| { kind: "refused"; refusal: AskRefusal };
// The state the board's pieces share.
export type CommentStore = {
	memory: AllComments; // the comments as the page holds them; starts as the site's
	warnings: Map<string, CommentWarning>; // comment id -> why it wasn't saved or deleted
	asks: Map<string, Ask>; // thread id -> its question to Claude, while it is answered or after a refusal
	views: Map<Element, CommentView>; // article element -> its entry's view
	unfolded: Set<string>; // Claude's replies the reader opened in full, by comment id, so a redraw keeps them open
};

// Where focus goes after a save: the sheet's ring-free inner wrapper after a question to Claude, else null.
export function focusAfterSave(
	panel: HTMLDialogElement,
	askedClaude: boolean,
): HTMLElement | null {
	if (!askedClaude) return null;
	return panel.querySelector<HTMLElement>(".comment-panel__inner");
}

// The comments on every entry: one view per entry, drawn from `store.memory`, which starts as `saved` (the site's) and
// changes at once with each change the page sends through `sender`. A highlight the site didn't take goes back to
// what it was, and `notice` says why. At 1386 px and wider each entry's cards sit in a
// column to its right, level with what they comment on; narrower, a count button opens them in a side panel.
// One comment box (a draft) is open at a time.
export function createCommentBoard(
	saved: AllComments,
	sender: Sender,
	notice: (text: string) => void,
	readAgain: () => Promise<boolean>,
): CommentBoard {
	const columnQuery = window.matchMedia(COMMENT_COLUMN_QUERY);
	const phoneQuery = window.matchMedia(PHONE_QUERY);
	const touchQuery = window.matchMedia(TOUCH_QUERY);
	const store: CommentStore = {
		memory: saved,
		warnings: new Map(),
		asks: new Map(),
		views: new Map(),
		unfolded: new Set(),
	};
	let lastDraftView: CommentView | null = null; // the view whose comment box was opened last, shown when the window narrows

	// The side panel: a modal <dialog>, so the browser dims the page behind it and Escape closes it. On a phone it is a
	// sheet along the bottom with a handle to swipe it down by (style.css, site/page/phone.ts).
	let panelView: CommentView | null = null; // the view the panel shows
	const panel = createPanel({
		titleId: "comment-panel-title",
		title: "Comments",
		onClose: () => {
			const view = panelView;
			panelView = null;
			// An open comment box is kept: Comment (or its highlight) opens it again with the text in it.
			if (view) drawView(view);
		},
	});
	const panelBody = panel.body;

	// The board's pieces, each given what it needs from the board.
	const { placeAll, placeSoon } = createPlacing({
		views: () => store.views.values(),
		articleOf: articleOf,
	});
	const { askAbout, askOf, fillAsk } = createAsks({
		store: store,
		drawEntry: drawEntry,
		unsaved: unsaved,
		readAgain: readAgain,
		notice: notice,
		replyBox: replyBox,
	});
	const selection = createSelection({
		store: store,
		touchQuery: touchQuery,
		viewOf: viewOf,
		addHighlight: addHighlight,
		removeHighlight: removeHighlight,
		openDraft: openDraft,
		showThread: showThread,
	});
	const { editor } = createEditor({
		touchQuery: touchQuery,
		phoneQuery: phoneQuery,
		saveDraft: saveDraft,
		closeDraft: closeDraft,
	});
	const { threadCard, keepOrphanedText } = createCards({
		store: store,
		editor: editor,
		openDraft: openDraft,
		deleteComment: deleteComment,
		askOf: askOf,
		fillAsk: fillAsk,
		articleOf: articleOf,
		replyBox: replyBox,
	});

	// The view of the entry an element sits in, or undefined.
	function viewOf(node: Element) {
		const article = node.closest("article.entry");
		if (article === null) return undefined;
		return store.views.get(article);
	}

	// The entry's <article>; attach sets it right after entryView builds the view.
	function articleOf(view: CommentView) {
		if (view.article === null)
			throw new Error(`Comments on ${view.entry.id} have no entry in the page`);
		return view.article;
	}

	// Whether a comment shows "Not saved: ...": the site never got its last save.
	function unsaved(commentId: string) {
		const warning = store.warnings.get(commentId);
		return warning !== undefined && warning.text.startsWith("Not saved");
	}

	// A new comment, a reply or an edit: `change` makes it in the page, where it shows at once, and the comment goes to
	// the site on its own, by its id, with the thread's place; a comment another device added to the thread is left as
	// it is. A comment of the thread the site didn't save before goes along, in the thread's order. When the site
	// doesn't save it, the comment stays in the page with "Not saved: ..." on it.
	function commitSave(
		entryId: string,
		threadId: string,
		commentId: string,
		change: (all: AllComments) => void,
	) {
		change(store.memory);
		store.warnings.delete(commentId);
		const thread = findThread(store.memory, entryId, threadId);
		// A reply or an edit to a thread the site's state no longer holds changed nothing: there is nothing to send.
		if (thread === null) return;

		// A comment that ends its thread and mentions @Claude asks Claude, which the thread says at once. A refusal from
		// an earlier question is not this comment's.
		let asking = false;
		const shown = usableThreads(store.memory[entryId]).find(
			(each) => each.id === threadId,
		);
		if (shown !== undefined) {
			const question = questionOf(shown);
			asking = question !== null && question.id === commentId;
		}
		const earlier = store.asks.get(threadId);
		if (asking) {
			store.asks.set(threadId, { kind: "answering", text: "", done: false });
		} else if (earlier !== undefined && earlier.kind === "refused") {
			store.asks.delete(threadId);
		}

		// The comments to save, as the page holds them without their author (the site sets it and refuses a comment that
		// names one); the Worker checks their shape.
		const save: unknown[] = [];
		const savedIds: string[] = [];
		for (const comment of thread.comments) {
			if (!isJsonObject(comment) || typeof comment.id !== "string") continue;
			if (comment.id === commentId || unsaved(comment.id)) {
				const { author: _author, ...withoutAuthor } = comment;
				save.push(withoutAuthor);
				savedIds.push(comment.id);
			}
		}
		// In CommentsChange's shape.
		const body = {
			entryId: entryId,
			thread: threadPlace(thread),
			save: save,
			delete: [],
		};
		sender
			.send("comments", entryId, body)
			.then((saved) => {
				if (saved) {
					// A comment sent along that showed "Not saved" is saved now. The entry already shows the change, so it
					// is drawn again only when a warning went.
					let clearedWarning = false;
					for (const id of savedIds) {
						if (store.warnings.delete(id)) clearedWarning = true;
					}
					if (clearedWarning) drawEntry(entryId);
					if (asking) {
						askAbout(entryId, threadId).catch((error) =>
							console.error("Claude's answer not drawn:", error),
						);
					}
					return;
				}
				// A question the site never got isn't answered.
				if (asking) store.asks.delete(threadId);
				store.warnings.set(commentId, {
					text: `Not saved: ${UNREACHABLE}`,
					entryId: entryId,
				});
				drawEntry(entryId);
			})
			.catch((error) => console.error("A comment change not drawn:", error));
	}

	// Delete comment `index` of `thread`: a reply goes alone; the thread's first comment takes every comment the page
	// knows in the thread. It shows at once, and the site deletes those comments by their ids, so a reply another
	// device added stays there. When the site doesn't delete them, they go back into the thread as it is by then, and
	// the comment shows "Not deleted: ...".
	function commitDelete(entryId: string, thread: Thread, index: number) {
		const comment = thread.comments[index];
		if (comment === undefined)
			throw new Error(`Thread ${thread.id} has no comment ${index}`);
		const commentId = comment.id;
		// Where the thread sat among the entry's threads, and the comments taken with their places, to put them back.
		const position = threadList(store.memory, entryId).findIndex(
			(stored) => isJsonObject(stored) && stored.id === thread.id,
		);
		const taken: TakenComment[] = [];
		if (index === 0) {
			thread.comments.forEach((each, at) => {
				taken.push({ comment: each, index: at });
			});
		} else {
			taken.push({ comment: comment, index: index });
		}
		const place = threadPlace(thread);
		const threads = removeComment(
			threadList(store.memory, entryId),
			thread.id,
			commentId,
		);
		if (threads.length) store.memory[entryId] = threads;
		else delete store.memory[entryId];
		store.warnings.delete(commentId);

		const body: CommentsChange = {
			entryId: entryId,
			thread: place,
			save: [],
			delete: taken.map((item) => item.comment.id),
		};
		sender
			.send("comments", entryId, body)
			.then((deleted) => {
				if (deleted) {
					// A warning on a comment that is gone would keep its entry from the site's state read again.
					for (const item of taken) store.warnings.delete(item.comment.id);
					return;
				}
				putBack(entryId, place, position, taken);
				store.warnings.set(commentId, {
					text: `Not deleted: ${UNREACHABLE}`,
					entryId: entryId,
				});
				drawEntry(entryId);
			})
			.catch((error) => console.error("A comment change not drawn:", error));
	}

	// Put comments a refused delete took back into their thread as the page now holds it, each at its old place or
	// at the end; a comment already back (the site's state read again) isn't added twice. A thread the page no longer
	// holds comes back at its old place among the entry's threads.
	function putBack(
		entryId: string,
		place: ThreadPlace,
		position: number,
		taken: TakenComment[],
	) {
		const threads = threadList(store.memory, entryId).slice();
		let at = threads.findIndex(
			(stored) => isJsonObject(stored) && stored.id === place.id,
		);
		// The thread as it is now: a copy of its fields, with its comments in a new list.
		const restored: Record<string, unknown> = {
			id: place.id,
			field: place.field,
			passage: place.passage,
			occurrence: place.occurrence,
		};
		let comments: unknown[] = [];
		const current = threads[at];
		if (isJsonObject(current) && Array.isArray(current.comments)) {
			for (const key of Object.keys(current)) {
				restored[key] = current[key];
			}
			comments = current.comments.slice();
		} else {
			at = threads.length;
			if (position >= 0 && position < threads.length) at = position;
			threads.splice(at, 0, restored);
		}
		for (const item of taken) {
			const back = comments.some(
				(each) => isJsonObject(each) && each.id === item.comment.id,
			);
			if (!back) {
				comments.splice(Math.min(item.index, comments.length), 0, item.comment);
			}
		}
		restored.comments = comments;
		threads[at] = restored;
		store.memory[entryId] = threads;
	}

	// Highlight a passage: a thread with no comments, which shows at once and goes to the site with "highlight": true.
	// When the site doesn't save it, and nothing was written in it meanwhile, it goes again and the page says why.
	function addHighlight(view: CommentView, anchor: PassageAnchor) {
		const entryId = view.entry.id;
		const thread = {
			id: newId(),
			field: anchor.field,
			passage: anchor.passage,
			occurrence: anchor.occurrence,
			highlight: true,
			comments: [],
		};
		store.memory[entryId] = threadList(store.memory, entryId).concat([thread]);
		drawView(view);
		const body: CommentsChange = {
			entryId: entryId,
			thread: threadPlace(thread),
			save: [],
			delete: [],
			highlight: true,
		};
		sender
			.send("comments", entryId, body)
			.then((saved) => {
				if (saved) return;
				const stored = findThread(store.memory, entryId, thread.id);
				if (stored !== null && stored.comments.length === 0) {
					takeThread(entryId, thread.id);
					drawEntry(entryId);
				}
				notice(`Not saved: ${UNREACHABLE}`);
			})
			.catch((error) => console.error("A highlight not drawn:", error));
	}

	// Remove a highlight without comments: it goes at once, and the site clears its flag, which removes the empty
	// thread. When the site doesn't, the highlight comes back at its old place and the page says why.
	function removeHighlight(view: CommentView, threadId: string) {
		const entryId = view.entry.id;
		const thread = findThread(store.memory, entryId, threadId);
		if (thread === null) return;
		const position = takeThread(entryId, threadId);
		drawView(view);
		const body: CommentsChange = {
			entryId: entryId,
			thread: threadPlace(thread),
			save: [],
			delete: [],
			highlight: false,
		};
		sender
			.send("comments", entryId, body)
			.then((removed) => {
				if (removed) return;
				if (findThread(store.memory, entryId, threadId) === null) {
					const threads = threadList(store.memory, entryId).slice();
					threads.splice(Math.min(position, threads.length), 0, thread);
					store.memory[entryId] = threads;
					drawEntry(entryId);
				}
				notice(`Not removed: ${UNREACHABLE}`);
			})
			.catch((error) => console.error("A highlight not drawn:", error));
	}

	// Take a thread out of an entry's threads in `store.memory`; where it was among them.
	function takeThread(entryId: string, threadId: string) {
		const threads = threadList(store.memory, entryId);
		const position = threads.findIndex(
			(stored) => isJsonObject(stored) && stored.id === threadId,
		);
		const kept = threads.filter(
			(stored) => !isJsonObject(stored) || stored.id !== threadId,
		);
		if (kept.length) store.memory[entryId] = kept;
		else delete store.memory[entryId];
		return position;
	}

	// Draw the comments of one entry wherever it shows.
	function drawEntry(entryId: string) {
		for (const view of store.views.values()) {
			if (view.entry.id === entryId) drawView(view);
		}
	}

	// Take the site's comments as the page's own. An entry with a change still on its way to the site, or with a
	// comment the site didn't save, keeps what the page holds. Open comment boxes stay as they are.
	function replace(fresh: AllComments) {
		const kept = new Set<string>();
		for (const warning of store.warnings.values()) {
			if (warning.text.startsWith("Not saved")) kept.add(warning.entryId);
		}
		store.memory = takeSiteState(
			fresh,
			store.memory,
			(entryId) => kept.has(entryId) || sender.pending("comments", entryId),
			(threads) => threads,
		);
		drawAll();
	}

	// ---- one entry ----

	function entryView(entry: Entry, fields: CommentFields) {
		const view: CommentView = {
			entry: entry,
			fields: fields,
			article: null,
			draft: null,
			cards: [],
			addButton: railButton("comment-add", "comment", "Comment"),
			countButton: el("button", {
				type: "button",
				class: "rail-button comment-count",
				hidden: "",
			}),
			column: el("div", { class: "entry__comments" }),
		};
		view.addButton.addEventListener("click", () => {
			openDraft(view, {
				kind: "new",
				field: null,
				passage: null,
				occurrence: null,
				text: "",
			});
		});
		view.countButton.addEventListener("click", () => openPanel(view, null));
		return view;
	}

	function attach(view: CommentView, article: HTMLElement) {
		view.article = article;
		store.views.set(article, view);
	}

	// Whether two comment boxes are for the same thing: the same new comment, reply or edit. Each kind is checked on
	// both, so TypeScript knows which fields they have.
	function sameTarget(a: Draft, b: Draft) {
		if (a.kind === "new" && b.kind === "new")
			return (
				a.field === b.field &&
				a.passage === b.passage &&
				a.occurrence === b.occurrence
			);
		if (a.kind === "reply" && b.kind === "reply")
			return a.threadId === b.threadId;
		if (a.kind === "edit" && b.kind === "edit")
			return a.threadId === b.threadId && a.commentId === b.commentId;
		return false;
	}

	// Open a comment box on `view`; each entry keeps its own. The box it already has for the same thing opens again
	// with its text; replacing a box that holds text asks first. On a narrow window it opens in the side panel.
	function openDraft(view: CommentView, draft: Draft) {
		const current = view.draft;
		if (current && sameTarget(current, draft)) {
			draft = current;
		} else if (
			current &&
			current.text.trim() !== "" &&
			!window.confirm("Discard the comment you started?")
		) {
			draft = current;
		}
		draft.focus = true;
		view.draft = draft;
		lastDraftView = view;
		if (columnQuery.matches) drawView(view);
		else openPanel(view, null);
	}

	function closeDraft(view: CommentView) {
		view.draft = null;
		drawView(view);
	}

	function openPanel(view: CommentView, threadId: string | null) {
		const previous = panelView;
		panelView = view;
		if (previous && previous !== view) drawView(previous);
		if (!panel.dialog.open) panel.open(phoneQuery.matches);
		drawView(view);
		if (threadId !== null) focusCard(panelBody, threadId);
	}

	function focusCard(container: Element, threadId: string) {
		const card = container.querySelector(
			`.comment-thread[data-thread="${CSS.escape(threadId)}"]`,
		);
		if (card instanceof HTMLElement) card.focus();
	}

	// Bring a thread's card into view: focus it in the column, or open the panel at it.
	function showThread(view: CommentView, threadId: string) {
		if (columnQuery.matches) focusCard(view.column, threadId);
		else openPanel(view, threadId);
	}

	// Save what the open comment box holds, as a new thread, a reply or an edit.
	function saveDraft(view: CommentView, text: string) {
		const draft = view.draft;
		// Only an open comment box saves.
		if (draft === null) throw new Error("No comment box to save");
		const entryId = view.entry.id;
		const now = new Date().toISOString();
		if (draft.kind === "new") {
			const comment = { id: newId(), text: text, created: now, edited: null };
			const thread = {
				id: newId(),
				field: draft.field,
				passage: draft.passage,
				occurrence: draft.occurrence,
				comments: [comment],
			};
			commitSave(entryId, thread.id, comment.id, (all) => {
				all[entryId] = threadList(all, entryId).concat([thread]);
			});
		}
		if (draft.kind === "reply") {
			const comment = { id: newId(), text: text, created: now, edited: null };
			commitSave(entryId, draft.threadId, comment.id, (all) => {
				const thread = findThread(all, entryId, draft.threadId);
				if (thread) thread.comments.push(comment);
			});
		}
		if (draft.kind === "edit") {
			commitSave(entryId, draft.threadId, draft.commentId, (all) => {
				const thread = findThread(all, entryId, draft.threadId);
				if (!thread) return;
				for (const comment of thread.comments) {
					if (isJsonObject(comment) && comment.id === draft.commentId) {
						comment.text = text;
						comment.edited = now;
					}
				}
			});
		}
		closeDraft(view);
		// On a phone the sheet closes once saved; a question to Claude keeps it open, focused, to show the answer.
		if (
			panel.dialog.open &&
			panel.dialog.classList.contains("comment-panel--sheet")
		) {
			const askedClaude = mentionsClaude(text);
			const target = focusAfterSave(panel.dialog, askedClaude);
			if (target) target.focus({ preventScroll: true });
			else panel.dialog.close();
		}
	}

	// Close the sheet when it is swiped down, as its close button does: an unsaved comment is kept for next time.
	function dismissSheet() {
		panel.closeButton.click();
	}

	function deleteComment(view: CommentView, thread: Thread, index: number) {
		if (!window.confirm(deleteQuestion(thread, index))) return;
		commitDelete(view.entry.id, thread, index);
		drawView(view);
	}

	// ---- drawing ----

	// The Markdown renderer (marked and DOMPurify) is a file of its own, fetched the first time a reply of Claude's is
	// drawn, so a page with none never loads it. Until it is here a reply is drawn as written; the threads are drawn
	// again when it arrives. A failed fetch leaves the reply as written, and the next reply drawn tries again.
	let renderMarkdown: typeof renderClaudeMarkdown | null = null;
	let fetchingRenderer = false;
	function fetchRenderer() {
		if (fetchingRenderer) return;
		fetchingRenderer = true;
		import("./claude-markdown.js")
			.then((module) => {
				renderMarkdown = module.renderClaudeMarkdown;
				drawAll();
			})
			.catch((error) => {
				fetchingRenderer = false;
				console.error("The Markdown renderer did not load:", error);
			});
	}

	// Claude's reply in a box of `boxClass`: from Markdown once the renderer is here, as written until then.
	function replyBox(boxClass: string, text: string) {
		if (renderMarkdown === null) {
			fetchRenderer();
			return el("p", { class: boxClass }, text);
		}
		const box = el("div", { class: `${boxClass} comment__text--markdown` });
		box.append(renderMarkdown(text));
		return box;
	}

	// Draw an entry's comments from `store.memory`: its highlights, its count, and its cards in the column or the panel.
	function drawView(view: CommentView) {
		const stored = store.memory[view.entry.id];
		const threads = usableThreads(stored);
		if (
			stored !== undefined &&
			(!Array.isArray(stored) || threads.length < stored.length)
		) {
			console.warn(
				`Comments on ${view.entry.id} that can't be shown were skipped:`,
				stored,
			);
		}
		keepOrphanedText(view, threads);
		const draft = view.draft;
		// Keep the comment box's focus and cursor across a redraw (the site's state read again redraws).
		const active = document.activeElement;
		let caret: number | null = null;
		const boxHadFocus =
			active instanceof HTMLTextAreaElement &&
			(view.column.contains(active) || panelBody.contains(active));
		if (draft && boxHadFocus) caret = active.selectionStart;

		// Highlights. Each thread's passage is found again by its text and occurrence; `missing` when it is gone.
		for (const name of ["title", "abstract"] as const) {
			const fieldElement = view.fields[name];
			if (fieldElement) unwrapPassages(fieldElement);
		}
		const RANK = { title: 1, abstract: 2 };
		const items: PlacedCard[] = [];
		// `anchor` is the thread itself, or the new comment's box: its field, passage and occurrence.
		function place(
			thread: Thread | null,
			anchor: PassageAnchor | WholeAnchor | WholeDraftAnchor,
			id: string,
		) {
			const item: PlacedCard = {
				thread: thread,
				rank: 0,
				start: 0,
				missing: false,
			};
			if (!anchor.field) return item;
			const field = anchor.field;
			const passage = anchor.passage;
			const element = view.fields[field];
			// No abstract to look in, or the passage isn't in its field: the card says it is missing.
			if (!element) {
				item.missing = true;
				return item;
			}
			const start = findPassage(
				fieldText(element).text,
				passage,
				anchor.occurrence,
			);
			if (start === -1) {
				item.missing = true;
				return item;
			}
			wrapPassage(element, start, start + passage.length, id);
			item.rank = RANK[field];
			item.start = start;
			return item;
		}
		for (const thread of threads) items.push(place(thread, thread, thread.id));
		let draftItem: PlacedCard | null = null;
		if (draft && draft.kind === "new") {
			draftItem = place(null, draft, "new");
			items.push(draftItem);
		}
		// Whole-entry threads (and lost passages) first, then the title's passages, then the abstract's, in text order.
		// sort keeps equal items in their saved order.
		items.sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			return a.start - b.start;
		});

		// The count reads as the number alone in the rail; its name and tooltip say what it counts: threads with
		// comments, so a highlight without one isn't counted.
		let commented = 0;
		for (const thread of threads) {
			if (thread.comments.length > 0) commented += 1;
		}
		view.countButton.hidden = commented === 0;
		view.countButton.setAttribute("aria-label", `Comments: ${commented}`);
		view.countButton.setAttribute("title", `Comments: ${commented}`);
		view.countButton.textContent = String(commented);

		const inPanel = panelView === view;
		const cards: Card[] = [];
		for (const item of items) {
			// A highlight without comments has no card, unless a comment is being written in it.
			const thread = item.thread;
			if (
				thread !== null &&
				thread.comments.length === 0 &&
				!(draft && draft.kind === "reply" && draft.threadId === thread.id)
			)
				continue;
			let node: HTMLElement | null = null;
			let anchor: Element = view.fields.title;
			// The new comment's box is the one item without a thread (draftItem).
			if (item.thread === null) {
				node = el("div", { class: "comment-draft" });
				if (draft && draft.kind === "new" && draft.passage && inPanel)
					node.append(
						el("blockquote", { class: "comment-thread__quote" }, draft.passage),
					);
				node.append(editor(view));
				if (item.rank)
					anchor =
						articleOf(view).querySelector(
							'mark.comment-mark[data-thread="new"]',
						) || anchor;
			} else {
				node = threadCard(view, item.thread, item.missing, inPanel);
				if (item.rank)
					anchor =
						articleOf(view).querySelector(
							'mark.comment-mark[data-thread="' +
								CSS.escape(item.thread.id) +
								'"]',
						) || anchor;
			}
			cards.push({ node: node, anchor: anchor });
		}

		view.cards = [];
		if (inPanel) {
			panelBody.replaceChildren(...cards.map((card) => card.node));
			view.column.replaceChildren();
		} else if (columnQuery.matches) {
			view.column.replaceChildren(...cards.map((card) => card.node));
			view.cards = cards;
		} else {
			view.column.replaceChildren();
		}

		// Focus the comment box when it has just opened, or had focus before the redraw.
		let holder: HTMLElement = view.column;
		if (inPanel) holder = panelBody;
		const box = holder.querySelector(".comment-editor textarea");
		if (
			box instanceof HTMLTextAreaElement &&
			draft &&
			(draft.focus || caret !== null)
		) {
			// Placed first, so focus scrolls to the box's place.
			placeAll();
			draft.focus = false;
			// In the sheet the page behind stays where it was.
			box.focus({ preventScroll: inPanel && phoneQuery.matches });
			let at = box.value.length;
			if (caret !== null) at = caret;
			box.setSelectionRange(at, at);
		} else {
			placeSoon();
		}
	}

	function drawAll() {
		for (const view of store.views.values()) drawView(view);
	}

	// Draw the comments of the entries inside `container`: a day whose month loaded after start() drew the rest.
	function drawIn(container: Element) {
		for (const view of store.views.values()) {
			if (view.article !== null && container.contains(view.article)) {
				drawView(view);
			}
		}
	}

	// ---- page-wide listeners ----

	function start() {
		document.body.append(selection.buttons, selection.menu, panel.dialog);
		selection.listen();

		// Crossing 1386 px moves the cards between the column and the panel.
		columnQuery.addEventListener("change", () => {
			if (columnQuery.matches && panel.dialog.open) panel.dialog.close();
			drawAll();
			// Narrowed with a comment box open in the column: it goes on in the side panel.
			if (!columnQuery.matches && lastDraftView && lastDraftView.draft)
				openPanel(lastDraftView, null);
		});
		// Lines rewrap when the window resizes, the web font arrives, or a day unfolds: place the cards again.
		window.addEventListener("resize", placeAll);
		document.fonts.ready.then(placeAll);
		for (const details of document.querySelectorAll("main details"))
			details.addEventListener("toggle", placeAll);

		drawAll();
	}

	return {
		entryView: entryView,
		attach: attach,
		start: start,
		placeAll: placeAll,
		drawIn: drawIn,
		replace: replace,
		sheet: panel.dialog,
		sheetHandle: panel.handle,
		dismissSheet: dismissSheet,
	};
}
