// The comment box: the typed text over a layer that colours @Claude and draws the mention suggestion.

import type { CommentView } from "../comment-board.ts";
import { el } from "../dom.ts";
import { withIcon } from "../icons.ts";
import {
	acceptMention,
	mentionNodes,
	mentionSuggestion,
	suggestionChip,
} from "../mention.ts";

// What the comment box needs from the board.
export type EditorNeeds = {
	touchQuery: MediaQueryList;
	phoneQuery: MediaQueryList;
	saveDraft: (view: CommentView, text: string) => void;
	closeDraft: (view: CommentView) => void;
};

export function createEditor(needs: EditorNeeds): {
	editor: (view: CommentView) => HTMLFormElement;
} {
	const touchQuery = needs.touchQuery;
	const phoneQuery = needs.phoneQuery;
	const saveDraft = needs.saveDraft;
	const closeDraft = needs.closeDraft;

	// A comment box: Save (only with some text) and Cancel; Cmd or Ctrl+Enter saves, Escape cancels.
	function editor(view: CommentView) {
		const draft = view.draft;
		// A box is drawn only for an open draft.
		if (draft === null) throw new Error("No comment box to draw");
		const textarea = el("textarea", { rows: "3", "aria-label": "Comment" });
		textarea.value = draft.text;
		const save = withIcon(
			el("button", { type: "submit", class: "comment-editor__save" }),
			"Save",
		);
		const cancel = withIcon(
			el("button", { type: "button", class: "comment-editor__cancel" }),
			"Cancel",
		);
		// The layer behind the textarea draws the suggestion after the caret; the textarea's own text stays on top.
		const layer = el("div", {
			class: "comment-editor__layer",
			"aria-hidden": "true",
		});
		// On a touch screen a chip under the box takes the suggestion, where Tab and arrows cannot.
		const chipSlot = el("div", { class: "comment-editor__chip-slot" });
		const form = el(
			"form",
			{ class: "comment-editor" },
			el("div", { class: "comment-editor__field" }, layer, textarea),
			chipSlot,
			el("div", { class: "comment-editor__buttons" }, save, cancel),
		);
		// Draw the text with each "@Claude" in orange, and the suggestion in grey where the caret is.
		const drawLayer = () => {
			const text = textarea.value;
			const caret = textarea.selectionStart;
			const suggestion = mentionSuggestion(text, caret);
			layer.replaceChildren();
			if (
				suggestion !== null &&
				caret === textarea.selectionEnd &&
				document.activeElement === textarea
			) {
				layer.append(
					...mentionNodes(text.slice(0, caret)),
					el("span", { class: "comment-editor__suggestion" }, suggestion),
					// The text after the caret keeps the lines wrapping where the textarea wraps them.
					...mentionNodes(text.slice(caret)),
				);
			} else {
				layer.append(...mentionNodes(text));
			}
			// A last empty line takes room in the textarea, and needs a character to take room here.
			if (text.endsWith("\n")) layer.append(" ");
			layer.scrollTop = textarea.scrollTop;
			// The chip stays through a blur, so the tap that blurs the box still lands on it.
			const chip =
				touchQuery.matches && caret === textarea.selectionEnd
					? suggestionChip(suggestion, acceptSuggestion)
					: null;
			chipSlot.replaceChildren(...(chip ? [chip] : []));
		};
		// Fill in the suggestion and keep focus in the box.
		const acceptSuggestion = () => {
			textarea.focus({ preventScroll: phoneQuery.matches });
			acceptMention(textarea);
		};
		// Save stays off while the comment is empty.
		const updateSave = () => {
			save.disabled = textarea.value.trim() === "";
		};
		textarea.addEventListener("input", () => {
			draft.text = textarea.value;
			updateSave();
			drawLayer();
		});
		// The caret moves without an input: arrows, a click, focus.
		for (const name of ["keyup", "click", "focus", "blur", "scroll"])
			textarea.addEventListener(name, drawLayer);
		textarea.addEventListener("keydown", (event) => {
			// Tab, or → at the end of the text, accepts the suggestion; without one they keep their usual job.
			const atEnd =
				textarea.selectionStart === textarea.value.length &&
				textarea.selectionEnd === textarea.value.length;
			const plain = !(
				event.shiftKey ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey
			);
			const suggested =
				mentionSuggestion(textarea.value, textarea.selectionStart) !== null &&
				textarea.selectionStart === textarea.selectionEnd;
			if (
				suggested &&
				plain &&
				(event.key === "Tab" || (event.key === "ArrowRight" && atEnd))
			) {
				event.preventDefault();
				acceptSuggestion();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				form.requestSubmit();
			}
			// Escape cancels the comment only; preventDefault keeps the side panel open.
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeDraft(view);
			}
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (textarea.value.trim() === "") return;
			saveDraft(view, textarea.value);
		});
		cancel.addEventListener("click", () => closeDraft(view));
		drawLayer();
		updateSave();
		return form;
	}

	return { editor: editor };
}
