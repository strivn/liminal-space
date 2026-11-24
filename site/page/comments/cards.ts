// A thread's card: its comments with their buttons, the fold of a long reply of Claude's, and the answer being written.

import type { CommentAuthor } from "../../../shared/owner-protocol.ts";
import type {
	Ask,
	CommentStore,
	CommentView,
	Draft,
} from "../comment-board.ts";
import { commentTime, replyCountText, showsFolded } from "../comments.ts";
import { siteFile } from "../data.ts";
import { el, status } from "../dom.ts";
import { type ActionName, actionIcon, withIcon } from "../icons.ts";
import { colourMentions } from "../mention.ts";
import type { SavedComment, Thread } from "../types.ts";
import { linkAddresses, typeset } from "../typeset.ts";

// A comment's author as its meta line names them; a comment with no author is the owner's.
const AUTHOR_NAMES: Record<CommentAuthor, string> = {
	owner: "You",
	claude: "Claude",
};

// What the cards need from the board. `replyBox` draws Claude's reply with the board's Markdown renderer.
export type CardsNeeds = {
	store: CommentStore;
	editor: (view: CommentView) => HTMLFormElement;
	openDraft: (view: CommentView, draft: Draft) => void;
	deleteComment: (view: CommentView, thread: Thread, index: number) => void;
	askOf: (thread: Thread) => Ask | null;
	fillAsk: (
		node: HTMLElement,
		entryId: string,
		threadId: string,
		ask: Ask,
	) => void;
	articleOf: (view: CommentView) => HTMLElement;
	drawView: (view: CommentView) => void;
	replyBox: (
		boxClass: string,
		text: string,
	) => HTMLParagraphElement | HTMLDivElement;
};

// "Show more" under a comment, which shows its first 3 lines (style.css) until it is opened, by `key` in `unfolded`.
// The button stays hidden while the comment fits; it is measured whenever its box changes size, because the panel's
// width sets its lines.
export function foldButton(
	unfolded: Set<string>,
	text: HTMLElement,
	key: string,
): HTMLButtonElement {
	const button = el(
		"button",
		{ type: "button", class: "comment-action" },
		"Show more",
	);
	const show = (open: boolean) => {
		text.classList.toggle("comment__text--folded", !open);
		button.textContent = open ? "Show less" : "Show more";
		button.setAttribute("aria-expanded", String(open));
	};
	let open = unfolded.has(key);
	show(open);
	button.hidden = true;
	new ResizeObserver(() => {
		if (open) {
			button.hidden = false;
			return;
		}
		button.hidden = text.scrollHeight <= text.clientHeight;
	}).observe(text);
	button.addEventListener("click", () => {
		open = !open;
		if (open) unfolded.add(key);
		else unfolded.delete(key);
		show(open);
	});
	return button;
}

export function createCards(needs: CardsNeeds): {
	threadCard: (
		view: CommentView,
		thread: Thread,
		missing: boolean,
		inPanel: boolean,
	) => HTMLElement;
	keepOrphanedText: (view: CommentView, threads: Thread[]) => void;
} {
	const store = needs.store;
	const editor = needs.editor;
	const openDraft = needs.openDraft;
	const deleteComment = needs.deleteComment;
	const askOf = needs.askOf;
	const fillAsk = needs.fillAsk;
	const articleOf = needs.articleOf;
	const drawView = needs.drawView;
	const replyBox = needs.replyBox;

	// A small button with its icon before its word: Reply, Edit or Delete.
	function actionButton(text: ActionName, onClick: () => void) {
		const button = withIcon(
			el("button", { type: "button", class: "comment-action" }),
			text,
		);
		button.addEventListener("click", onClick);
		return button;
	}

	// One comment: "<owner> · 27 Sep, 23:20" ("Claude · ..." for Claude's reply), its text, and Edit and Delete, led by the
	// thread's Reply on its last comment; or the comment box while it is edited.
	function commentNode(
		view: CommentView,
		thread: Thread,
		comment: SavedComment,
		index: number,
	) {
		const author = AUTHOR_NAMES[comment.author || "owner"];
		let when = ` · ${commentTime(comment.created, new Date())}`;
		if (comment.edited) when += " · edited";
		const meta = el("p", { class: "comment__meta" });
		// Claude's name is in its orange, after Anthropic's Sonnet icon on an orange tile.
		if (comment.author === "claude") {
			meta.append(
				el(
					"span",
					{ class: "comment__tile" },
					el("img", { src: siteFile("claude-sonnet.svg"), alt: "" }),
				),
				el("span", { class: "comment__claude" }, author),
				when,
			);
		} else {
			meta.append(author + when);
		}
		const node = el("div", { class: "comment" }, meta);
		const draft = view.draft;
		if (
			draft &&
			draft.kind === "edit" &&
			draft.threadId === thread.id &&
			draft.commentId === comment.id
		) {
			node.append(editor(view));
			return node;
		}
		// Claude's replies are drawn from Markdown and typeset like an abstract; the owner's comments stay as written.
		let text = el("p", { class: "comment__text" }, comment.text);
		if (comment.author === "claude") {
			text = replyBox("comment__text", comment.text);
			typeset(text);
		}
		linkAddresses(text);
		// Only the owner's comments ask Claude, so only theirs show the mention in orange.
		if (comment.author !== "claude") colourMentions(text);
		node.append(text);
		const commentWarning = store.warnings.get(comment.id);
		if (commentWarning !== undefined) {
			const warning = status("warning", commentWarning.text);
			warning.classList.add("comment__warning");
			node.append(warning);
		}
		const actions = el("div", { class: "comment__actions" });
		const isLast = index === thread.comments.length - 1;
		// A reply opened while it streamed stays open once saved.
		if (comment.author === "claude" && isLast && store.unfolded.has(thread.id))
			store.unfolded.add(comment.id);
		actions.append(foldButton(store.unfolded, text, comment.id));
		const replying =
			draft && draft.kind === "reply" && draft.threadId === thread.id;
		if (isLast && !replying)
			actions.append(
				actionButton("Reply", () =>
					openDraft(view, { kind: "reply", threadId: thread.id, text: "" }),
				),
			);
		// Claude's replies can be deleted but not edited.
		if (comment.author !== "claude")
			actions.append(
				actionButton("Edit", () =>
					openDraft(view, {
						kind: "edit",
						threadId: thread.id,
						commentId: comment.id,
						text: comment.text,
					}),
				),
			);
		actions.append(
			actionButton("Delete", () => deleteComment(view, thread, index)),
		);
		node.append(actions);
		return node;
	}

	// Open or fold a thread, keeping focus on its toggle. Open, it is the fold icon alone.
	function threadToggle(
		view: CommentView,
		thread: Thread,
		text: string | null,
		open: boolean,
	) {
		const button = el("button", {
			type: "button",
			class: "comment-action comment-thread__toggle",
			"aria-expanded": String(open),
		});
		if (text === null) {
			button.setAttribute("aria-label", "Fold thread");
			button.setAttribute("title", "Fold thread");
			button.append(actionIcon("Collapse all"));
		} else {
			button.append(text);
		}
		button.addEventListener("click", () => {
			if (open) store.openThreads.delete(thread.id);
			else store.openThreads.add(thread.id);
			drawView(view);
			document
				.querySelector<HTMLElement>(
					`.comment-thread[data-thread="${CSS.escape(thread.id)}"] .comment-thread__toggle`,
				)
				?.focus();
		});
		return button;
	}

	// Marks of one thread, for the card's hover.
	function setActive(view: CommentView, threadId: string, active: boolean) {
		const marks = articleOf(view).querySelectorAll(
			`mark.comment-mark[data-thread="${CSS.escape(threadId)}"]`,
		);
		for (const mark of marks)
			mark.classList.toggle("comment-mark--active", active);
	}

	// A thread's card. The quote shows in the side panel, and in the column only when the passage is gone.
	function threadCard(
		view: CommentView,
		thread: Thread,
		missing: boolean,
		inPanel: boolean,
	) {
		const card = el("section", {
			class: "comment-thread",
			"data-thread": thread.id,
			tabindex: "-1",
		});
		if (missing)
			card.append(
				el("p", { class: "comment-thread__missing" }, "Passage not found"),
			);
		if (thread.passage && (missing || inPanel))
			card.append(
				el(
					"blockquote",
					{ class: "comment-thread__quote" },
					String(thread.passage),
				),
			);
		// A long thread shows its first and latest comments.
		const folded = showsFolded(thread, store.openThreads);
		const last = thread.comments.length - 1;
		if (!folded && thread.comments.length >= 4)
			card.append(threadToggle(view, thread, null, true));
		thread.comments.forEach((comment, index) => {
			if (folded && index === 1) {
				const count = replyCountText(last - 1);
				card.append(threadToggle(view, thread, count, false));
			}
			if (folded && index > 0 && index < last) return;
			card.append(commentNode(view, thread, comment, index));
		});
		// Claude's answer being written, or why it can't be, under the thread's last comment.
		const ask = askOf(thread);
		if (ask !== null) {
			const note = el("div", {
				class: "comment-ask",
				"data-thread": thread.id,
			});
			fillAsk(note, view.entry.id, thread.id, ask);
			card.append(note);
		}
		const draft = view.draft;
		// A reply being written goes under the last comment. (Reply itself sits in the last comment's buttons.)
		if (draft && draft.kind === "reply" && draft.threadId === thread.id)
			card.append(editor(view));
		card.addEventListener("mouseenter", () => setActive(view, thread.id, true));
		card.addEventListener("mouseleave", () =>
			setActive(view, thread.id, false),
		);
		card.addEventListener("focusin", () => setActive(view, thread.id, true));
		card.addEventListener("focusout", () => setActive(view, thread.id, false));
		return card;
	}

	// A reply or an edit whose thread or comment another device deleted keeps its text as a new comment on the entry.
	function keepOrphanedText(view: CommentView, threads: Thread[]) {
		const draft = view.draft;
		if (!draft || draft.kind === "new") return;
		let found = false;
		for (const thread of threads) {
			if (thread.id !== draft.threadId) continue;
			if (draft.kind === "reply") found = true;
			for (const comment of thread.comments) {
				// Only an edit has a comment id.
				if (draft.kind === "edit" && comment.id === draft.commentId)
					found = true;
			}
		}
		if (found) return;
		view.draft = null;
		if (draft.text.trim() === "") return;
		view.draft = {
			kind: "new",
			field: null,
			passage: null,
			occurrence: null,
			text: draft.text,
			focus: false,
		};
	}

	return { threadCard: threadCard, keepOrphanedText: keepOrphanedText };
}
