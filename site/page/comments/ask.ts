// A thread's question to Claude: asking, the reply as it streams in, and a refusal with Retry.

import { ASK_MESSAGES } from "../../../shared/owner-protocol.ts";
import { askClaude } from "../claude-ask.ts";
import type { Ask, CommentStore } from "../comment-board.ts";
import { el, status } from "../dom.ts";
import type { Thread } from "../types.ts";
import { linkAddresses, typeset } from "../typeset.ts";
import { questionOf } from "./passage.ts";

// What the asks need from the board. `replyBox` draws Claude's reply with the board's Markdown renderer.
export type AsksNeeds = {
	store: CommentStore;
	drawEntry: (entryId: string) => void;
	unsaved: (commentId: string) => boolean;
	readAgain: () => Promise<boolean>;
	notice: (text: string) => void;
	replyBox: (
		boxClass: string,
		text: string,
	) => HTMLParagraphElement | HTMLDivElement;
};

export function createAsks(needs: AsksNeeds): {
	askAbout: (entryId: string, threadId: string) => Promise<void>;
	askOf: (thread: Thread) => Ask | null;
	fillAsk: (
		node: HTMLElement,
		entryId: string,
		threadId: string,
		ask: Ask,
	) => void;
} {
	const store = needs.store;
	const drawEntry = needs.drawEntry;
	const unsaved = needs.unsaved;
	const readAgain = needs.readAgain;
	const notice = needs.notice;
	const replyBox = needs.replyBox;

	// Ask Claude about a thread whose last comment the site holds: the thread shows the reply as it streams in, then
	// reads the site's state again for the reply the Worker saved. A refusal stays in the thread with its reason.
	async function askAbout(entryId: string, threadId: string) {
		const outcome = await askClaude(entryId, threadId, (soFar) => {
			const ask = store.asks.get(threadId);
			if (ask === undefined || ask.kind !== "answering") return;
			ask.text = soFar;
			showAsk(entryId, threadId);
		});
		if (!outcome.ok) {
			store.asks.set(threadId, { kind: "refused", refusal: outcome.refusal });
			drawEntry(entryId);
			return;
		}
		// The reply stays drawn as it streamed until the saved one replaces it.
		store.asks.set(threadId, {
			kind: "answering",
			text: outcome.text,
			done: true,
		});
		const read = await readAgain();
		if (read) {
			store.asks.delete(threadId);
		} else {
			notice("Claude's reply is saved. Reload the page to see it there.");
		}
		drawEntry(entryId);
	}

	// Ask again for a thread whose answer failed.
	function retryAsk(entryId: string, threadId: string) {
		store.asks.set(threadId, { kind: "answering", text: "", done: false });
		drawEntry(entryId);
		askAbout(entryId, threadId).catch((error) =>
			console.error("Claude's answer not drawn:", error),
		);
	}

	// What a thread says about its question to Claude, or null. An answer being written shows until the saved reply is
	// the thread's last comment. A refusal shows while the question is still the last comment; a question the page
	// never asked about (one a reload brought back, or another device wrote) counts as a failed answer.
	function askOf(thread: Thread): Ask | null {
		const known = store.asks.get(thread.id);
		if (questionOf(thread) === null) {
			if (known !== undefined && known.kind === "answering" && !known.done)
				return known;
			return null;
		}
		if (known !== undefined) return known;
		const last = thread.comments.at(-1);
		if (last === undefined || unsaved(last.id)) return null;
		return { kind: "refused", refusal: "failed" };
	}

	// Write what a thread says about its question into `node`: the note and the reply so far, or the reason it was
	// refused, with Retry when Claude failed.
	function fillAsk(
		node: HTMLElement,
		entryId: string,
		threadId: string,
		ask: Ask,
	) {
		node.replaceChildren();
		if (ask.kind === "refused") {
			const note = status("warning", ASK_MESSAGES[ask.refusal]);
			note.classList.add("comment-ask__note");
			node.append(note);
			if (ask.refusal === "failed") {
				const retry = el(
					"button",
					{ type: "button", class: "comment-action" },
					"Retry",
				);
				retry.addEventListener("click", () => retryAsk(entryId, threadId));
				node.append(el("div", { class: "comment__actions" }, retry));
			}
			return;
		}
		if (!ask.done) {
			node.append(
				el("p", { class: "comment-ask__note" }, ASK_MESSAGES.answering),
			);
		}
		if (ask.text === "") return;
		// Math is typeset once the reply is whole: a formula cut in two by a piece boundary would only be drawn wrong.
		const reply = replyBox("comment-ask__text", ask.text);
		if (ask.done) {
			typeset(reply);
			linkAddresses(reply);
		}
		node.append(reply);
	}

	// Draw the reply so far into the thread's answering note wherever it shows, without drawing the entry again.
	function showAsk(entryId: string, threadId: string) {
		const ask = store.asks.get(threadId);
		const nodes = document.querySelectorAll(
			`.comment-ask[data-thread="${CSS.escape(threadId)}"]`,
		);
		if (ask === undefined || nodes.length === 0) {
			drawEntry(entryId);
			return;
		}
		for (const node of nodes) {
			if (node instanceof HTMLElement) fillAsk(node, entryId, threadId, ask);
		}
	}

	return { askAbout: askAbout, askOf: askOf, fillAsk: fillAsk };
}
