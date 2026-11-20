// The Highlight and Comment buttons beside a selection, and the menu a click on a highlight without comments opens.

import type { CommentStore, CommentView, Draft } from "../comment-board.ts";
import { findThread } from "../comments.ts";
import { el, pageSelection, targetElement } from "../dom.ts";
import { iconSvg } from "../icons.ts";
import type { PassageAnchor } from "../types.ts";
import { fieldName, type SelectedPassage, selectedPassage } from "./passage.ts";

// What the selection buttons and the highlight menu need from the board.
export type SelectionNeeds = {
	store: CommentStore;
	touchQuery: MediaQueryList;
	viewOf: (node: Element) => CommentView | undefined;
	addHighlight: (view: CommentView, anchor: PassageAnchor) => void;
	removeHighlight: (view: CommentView, threadId: string) => void;
	openDraft: (view: CommentView, draft: Draft) => void;
	showThread: (view: CommentView, threadId: string) => void;
};

export function createSelection(needs: SelectionNeeds): {
	buttons: HTMLElement;
	menu: HTMLElement;
	listen: () => void;
} {
	const store = needs.store;
	const touchQuery = needs.touchQuery;
	const viewOf = needs.viewOf;
	const addHighlight = needs.addHighlight;
	const removeHighlight = needs.removeHighlight;
	const openDraft = needs.openDraft;
	const showThread = needs.showThread;

	// The Highlight and Comment buttons that show beside a selection in a title or abstract.
	const highlightButton = el(
		"button",
		{ type: "button", class: "highlight-float" },
		"Highlight",
	);
	const floatButton = el(
		"button",
		{ type: "button", class: "comment-float" },
		"Comment",
	);
	// Each word has its icon before it, beside a selection and in the bar on a touch screen.
	highlightButton.prepend(iconSvg("highlighter"));
	floatButton.prepend(iconSvg("comment"));
	const selectionButtons = el(
		"div",
		{ class: "selection-float", hidden: "" },
		highlightButton,
		floatButton,
	);
	let offered: SelectedPassage | null = null; // the passage the buttons offer to highlight or comment on
	// The passage offered when a finger pressed a button. iOS may clear the selection through its own tap before the
	// click arrives, so the press keeps the passage (and the bar showing) until its click or its cancel.
	let pressed: SelectedPassage | null = null;
	// Pressing a button would otherwise clear the selection before its click arrives: a mouse's press, and a finger's.
	selectionButtons.addEventListener("mousedown", (event) =>
		event.preventDefault(),
	);
	selectionButtons.addEventListener("pointerdown", (event) => {
		if (event.pointerType === "mouse") return;
		event.preventDefault();
		pressed = offered;
	});
	selectionButtons.addEventListener("pointercancel", () => {
		pressed = null;
	});
	// The offered passage's view and anchor, with the selection cleared.
	function takeOffered() {
		const found = offered || pressed;
		pressed = null;
		if (!found) return null;
		const view = viewOf(found.field);
		pageSelection().removeAllRanges();
		selectionButtons.hidden = true;
		// The buttons are offered only for an entry with a view.
		if (view === undefined) throw new Error("No comments view for this entry");
		const anchor: PassageAnchor = {
			field: fieldName(found.field),
			passage: found.passage,
			occurrence: found.occurrence,
		};
		return { view: view, anchor: anchor };
	}
	highlightButton.addEventListener("click", () => {
		const taken = takeOffered();
		if (taken) addHighlight(taken.view, taken.anchor);
	});
	floatButton.addEventListener("click", () => {
		const taken = takeOffered();
		if (!taken) return;
		openDraft(taken.view, {
			kind: "new",
			field: taken.anchor.field,
			passage: taken.anchor.passage,
			occurrence: taken.anchor.occurrence,
			text: "",
		});
	});

	// The menu a click on a highlight without comments opens: Comment, or Remove highlight. Two plain buttons that Tab
	// moves between: no arrow keys, so not an ARIA menu, whose role promises them.
	const menuComment = el("button", { type: "button" }, "Comment");
	const menuRemove = el("button", { type: "button" }, "Remove highlight");
	const highlightMenu = el(
		"div",
		{ class: "highlight-menu", hidden: "" },
		menuComment,
		menuRemove,
	);
	let menuFor: { view: CommentView; threadId: string } | null = null; // the highlight the menu is open on
	let menuMark: HTMLElement | null = null; // the highlight's mark, which takes focus back when Escape closes the menu
	menuComment.addEventListener("click", () => {
		const target = menuFor;
		closeMenu();
		if (target === null) return;
		openDraft(target.view, {
			kind: "reply",
			threadId: target.threadId,
			text: "",
		});
	});
	menuRemove.addEventListener("click", () => {
		const target = menuFor;
		closeMenu();
		if (target !== null) removeHighlight(target.view, target.threadId);
	});

	// Open the menu just below the highlight's last line, kept inside the window.
	function openMenu(view: CommentView, threadId: string, mark: HTMLElement) {
		menuFor = { view: view, threadId: threadId };
		menuMark = mark;
		highlightMenu.hidden = false;
		const lines = mark.getClientRects();
		const last = lines[lines.length - 1];
		if (last === undefined) throw new Error("The highlight has no box");
		const room =
			document.documentElement.clientWidth - highlightMenu.offsetWidth - 16;
		highlightMenu.style.top = `${last.bottom + window.scrollY + 4}px`;
		highlightMenu.style.left = `${Math.max(Math.min(last.left, room), 16) + window.scrollX}px`;
		menuComment.focus();
	}

	function closeMenu() {
		menuFor = null;
		menuMark = null;
		highlightMenu.hidden = true;
	}

	// The page-wide listeners of the selection buttons and the highlight menu.
	function listen() {
		// The floating Highlight and Comment buttons follow the selection.
		document.addEventListener("selectionchange", () => {
			const found = selectedPassage(document.getSelection());
			if (!found || viewOf(found.field) === undefined) {
				offered = null;
				if (pressed !== null) return;
				selectionButtons.hidden = true;
				return;
			}
			offered = found;
			closeMenu();
			selectionButtons.hidden = false;
			// On a touch screen, a bar fixed along the bottom (style.css).
			const asBar = touchQuery.matches;
			selectionButtons.classList.toggle("selection-float--bar", asBar);
			if (asBar) {
				selectionButtons.style.removeProperty("top");
				selectionButtons.style.removeProperty("left");
				return;
			}
			// Just below the end of the selection, kept inside the window.
			const rects = found.range.getClientRects();
			const end = rects[rects.length - 1];
			if (end === undefined) throw new Error("The selection has no box");
			const room =
				document.documentElement.clientWidth -
				selectionButtons.offsetWidth -
				16;
			selectionButtons.style.top = `${end.bottom + window.scrollY + 4}px`;
			selectionButtons.style.left = `${Math.max(Math.min(end.right, room), 16) + window.scrollX}px`;
		});

		// A click on a highlight shows its comment. A highlight in a title is inside the title's link: the click opens
		// the comment instead of the link. The end of a drag that selected text isn't a click on the highlight.
		document.addEventListener("click", (event) => {
			const target = targetElement(event);
			// A click anywhere but the highlight menu closes it; a click on a highlight may open it again below.
			if (!highlightMenu.contains(target)) closeMenu();
			// Releasing a drag that selected words in a title, or across a link in the text, counts as a click on the
			// link: keep the selection, stay here.
			if (
				target.closest(".entry__title a, a.text-link") &&
				!pageSelection().isCollapsed
			) {
				event.preventDefault();
				return;
			}
			const mark = target.closest("mark.comment-mark");
			if (!(mark instanceof HTMLElement)) return;
			if (!pageSelection().isCollapsed) return;
			const view = viewOf(mark);
			if (!view) return;
			event.preventDefault();
			// The highlight of a comment still being written opens its box again.
			// A mark always has data-thread; String() reads a missing one as "undefined".
			const threadId = String(mark.dataset.thread);
			const draft = view.draft;
			const thread = findThread(store.memory, view.entry.id, threadId);
			if (threadId === "new") {
				// That highlight is drawn only while the box is open.
				if (draft === null) throw new Error("No comment box to open");
				openDraft(view, draft);
			}
			// A highlight with a comment being written in it opens that box again.
			else if (draft && draft.kind === "reply" && draft.threadId === threadId)
				openDraft(view, draft);
			// A highlight without comments offers Comment and Remove highlight.
			else if (thread !== null && thread.comments.length === 0)
				openMenu(view, threadId, mark);
			else showThread(view, threadId);
		});

		// The highlight menu closes on Escape, and focus goes back to its highlight, where the next Tab carries on in the
		// entry; hidden with focus inside, the menu would drop focus to the top of the page. The mark takes focus only
		// from the script (tabindex -1), and gives it up again on blur.
		highlightMenu.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			const mark = menuMark;
			closeMenu();
			if (mark === null || !mark.isConnected) return;
			mark.setAttribute("tabindex", "-1");
			mark.addEventListener("blur", () => mark.removeAttribute("tabindex"), {
				once: true,
			});
			mark.focus();
		});
	}

	return { buttons: selectionButtons, menu: highlightMenu, listen: listen };
}
