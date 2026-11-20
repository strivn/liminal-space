// Takeaways on the owner's page: the Takeaway button in each entry's icon rail, and the
// panel where the owner reads, adds, edits and deletes an entry's takeaways.
import type {
	PageTakeaway,
	Takeaway,
	TakeawayChange,
	TakeawaySource,
} from "../../shared/owner-protocol.ts";
import { commentTime } from "./comments.ts";
import { el, status } from "./dom.ts";
import { railButton, showRailIcon, withIcon } from "./icons.ts";
import { type Sender, UNREACHABLE } from "./owner.ts";
import { PHONE_QUERY } from "./phone.ts";
import { createPanel } from "./sheet.ts";
import { newestFirst } from "./state.ts";
import type { AllTakeaways, Entry } from "./types.ts";

// What createTakeawayBoard hands the rest of the page: an entry's Takeaway button, and replace(fresh), which takes the
// site's takeaways when the page reads its state again.
export type TakeawayBoard = {
	button: (entry: Entry) => HTMLElement;
	replace: (fresh: AllTakeaways) => void;
};

// The takeaway box open on an entry: a new takeaway (id null) or an edit of one, with what is typed so far.
type Draft = { id: string | null; text: string; question: string };

// Where a takeaway came from, as its card names it.
const SOURCE_NAMES: Record<TakeawaySource, string> = {
	"claude.ai": "claude.ai",
	ChatGPT: "ChatGPT",
	page: "on the page",
};

// A takeaway's new id: random, so two devices never pick the same one.
function newId() {
	return crypto.randomUUID();
}

// The takeaways of every entry: `saved` is what the site holds; each change goes to the site through `sender`. A
// change the site doesn't save stays on the page with a warning under its card; a delete it doesn't make puts the card
// back. replace(fresh) takes the site's takeaways, except an entry's with a change still on its way.
export function createTakeawayBoard(
	saved: AllTakeaways,
	sender: Sender,
): TakeawayBoard {
	const phoneQuery = window.matchMedia(PHONE_QUERY);
	let memory: AllTakeaways = saved;
	const warnings = new Map<string, string>(); // takeaway id -> why it wasn't saved or deleted
	const drafts = new Map<string, Draft>(); // entry id -> its open box
	const counts: (() => void)[] = []; // each Takeaway button's count redraw
	let shown: Entry | null = null; // the entry the panel shows

	// The panel: a modal <dialog> as the comments' side panel is, so the browser dims the page behind it and Escape
	// closes it; on a phone it is a sheet along the bottom (style.css).
	const panel = createPanel({
		titleId: "takeaway-panel-title",
		title: "Takeaways",
		extraClass: "takeaway-panel",
		onClose: () => {
			shown = null;
		},
	});
	const body = panel.body;
	document.body.append(panel.dialog);

	function takeawaysOn(entryId: string): Takeaway[] {
		return memory[entryId] || [];
	}

	function redrawCounts() {
		for (const showCount of counts) showCount();
	}

	function open(entry: Entry) {
		shown = entry;
		// An entry without takeaways opens with its box ready.
		if (takeawaysOn(entry.id).length === 0 && !drafts.has(entry.id))
			drafts.set(entry.id, { id: null, text: "", question: "" });
		panel.open(phoneQuery.matches);
		draw();
	}

	// Draw the shown entry's panel: Add takeaway, the box when one is open for a new takeaway, then each card.
	function draw() {
		const entry = shown;
		if (entry === null) return;
		const active = document.activeElement;
		const focusedBox =
			active instanceof HTMLTextAreaElement && body.contains(active);
		let focusName: string | null = null;
		if (focusedBox) focusName = active.getAttribute("aria-label");
		const add = el(
			"button",
			{ type: "button", class: "takeaway-add" },
			"Add takeaway",
		);
		// A box already open for a new takeaway keeps what it holds; an edit's box gives way to a new one.
		add.addEventListener("click", () => {
			const current = drafts.get(entry.id);
			if (current === undefined || current.id !== null)
				drafts.set(entry.id, { id: null, text: "", question: "" });
			draw();
			focusBox("Takeaway");
		});
		const nodes: HTMLElement[] = [add];
		const draft = drafts.get(entry.id);
		if (draft !== undefined && draft.id === null)
			nodes.push(editor(entry, draft));
		for (const takeaway of takeawaysOn(entry.id))
			nodes.push(card(entry, takeaway));
		body.replaceChildren(...nodes);
		if (focusName !== null) focusBox(focusName);
		else if (draft !== undefined && draft.id === null && draft.text === "")
			focusBox("Takeaway");
	}

	function focusBox(name: string) {
		const box = body.querySelector(`textarea[aria-label="${name}"]`);
		if (box instanceof HTMLTextAreaElement) box.focus();
	}

	// The box: the takeaway, its question under it, Save (only with a takeaway) and Cancel.
	function editor(entry: Entry, draft: Draft) {
		const text = el("textarea", { rows: "3", "aria-label": "Takeaway" });
		text.value = draft.text;
		const question = el("textarea", { rows: "2", "aria-label": "Question" });
		question.value = draft.question;
		const save = withIcon(
			el("button", { type: "submit", class: "comment-editor__save" }),
			"Save",
		);
		const cancel = withIcon(
			el("button", { type: "button", class: "comment-editor__cancel" }),
			"Cancel",
		);
		const form = el(
			"form",
			{ class: "comment-editor takeaway-editor" },
			text,
			question,
			el("div", { class: "comment-editor__buttons" }, save, cancel),
		);
		const updateSave = () => {
			save.disabled = text.value.trim() === "";
		};
		text.addEventListener("input", () => {
			draft.text = text.value;
			updateSave();
		});
		question.addEventListener("input", () => {
			draft.question = question.value;
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (text.value.trim() === "") return;
			saveDraft(entry, draft);
		});
		cancel.addEventListener("click", () => {
			drafts.delete(entry.id);
			draw();
		});
		updateSave();
		return form;
	}

	// A card: the takeaway, "Q: <question>" when it has one, "27 Sep, 23:20 · claude.ai", and Edit and Delete; or the
	// box while it is edited.
	function card(entry: Entry, takeaway: Takeaway) {
		const node = el("section", {
			class: "takeaway-card",
			"data-takeaway": takeaway.id,
		});
		const draft = drafts.get(entry.id);
		if (draft !== undefined && draft.id === takeaway.id) {
			node.append(editor(entry, draft));
			return node;
		}
		node.append(el("p", { class: "takeaway-card__text" }, takeaway.text));
		if (takeaway.question !== null)
			node.append(
				el(
					"p",
					{ class: "takeaway-card__question" },
					`Q: ${takeaway.question}`,
				),
			);
		let meta = `${commentTime(takeaway.created, new Date())} · ${SOURCE_NAMES[takeaway.source]}`;
		if (takeaway.edited !== null) meta += " · edited";
		node.append(el("p", { class: "takeaway-card__meta" }, meta));
		const warning = warnings.get(takeaway.id);
		if (warning !== undefined) {
			const shownWarning = status("warning", warning);
			shownWarning.classList.add("takeaway-card__warning");
			node.append(shownWarning);
		}
		const edit = withIcon(
			el("button", { type: "button", class: "comment-action" }),
			"Edit",
		);
		edit.addEventListener("click", () => {
			drafts.set(entry.id, {
				id: takeaway.id,
				text: takeaway.text,
				question: takeaway.question || "",
			});
			draw();
			focusBox("Takeaway");
		});
		const remove = withIcon(
			el("button", { type: "button", class: "comment-action" }),
			"Delete",
		);
		remove.addEventListener("click", () => deleteTakeaway(entry, takeaway));
		node.append(el("div", { class: "comment__actions" }, edit, remove));
		return node;
	}

	// Save the box as a new takeaway or an edit: shown at once, then sent; one the site doesn't save keeps its card and
	// says so under it.
	function saveDraft(entry: Entry, draft: Draft) {
		const now = new Date().toISOString();
		const question = draft.question.trim();
		let kept: string | null = null;
		if (question !== "") kept = question;
		let takeaway: Takeaway = {
			id: newId(),
			text: draft.text.trim(),
			question: kept,
			created: now,
			edited: null,
			source: "page",
		};
		const others: Takeaway[] = [];
		for (const old of takeawaysOn(entry.id)) {
			if (old.id === draft.id) {
				takeaway = {
					id: old.id,
					text: draft.text.trim(),
					question: kept,
					created: old.created,
					edited: now,
					source: old.source,
				};
			} else {
				others.push(old);
			}
		}
		memory[entry.id] = newestFirst(others.concat([takeaway]));
		drafts.delete(entry.id);
		warnings.delete(takeaway.id);
		const save: PageTakeaway = {
			id: takeaway.id,
			text: takeaway.text,
			question: takeaway.question,
			created: takeaway.created,
			edited: takeaway.edited,
		};
		send(entry, { entryId: entry.id, save: save }, takeaway.id, "Not saved");
		redrawCounts();
		draw();
	}

	function deleteTakeaway(entry: Entry, takeaway: Takeaway) {
		if (!window.confirm("Delete this takeaway?")) return;
		const before = takeawaysOn(entry.id);
		const left = before.filter((each) => each.id !== takeaway.id);
		if (left.length === 0) delete memory[entry.id];
		else memory[entry.id] = left;
		warnings.delete(takeaway.id);
		send(
			entry,
			{ entryId: entry.id, delete: takeaway.id },
			takeaway.id,
			"Not deleted",
			() => {
				memory[entry.id] = newestFirst(
					takeawaysOn(entry.id).concat([takeaway]),
				);
			},
		);
		redrawCounts();
		draw();
	}

	// Send one change; when the site doesn't take it, undo what `undo` undoes and warn on the takeaway's card.
	function send(
		entry: Entry,
		change: TakeawayChange,
		takeawayId: string,
		what: string,
		undo?: () => void,
	) {
		sender
			.send("takeaways", entry.id, change)
			.then((stored) => {
				if (stored) return;
				if (undo !== undefined) undo();
				warnings.set(takeawayId, `${what}: ${UNREACHABLE}`);
				redrawCounts();
				if (shown !== null && shown.id === entry.id) draw();
			})
			.catch((error) => console.error("A takeaway not drawn:", error));
	}

	function button(entry: Entry) {
		const takeaway = railButton("takeaway", "takeaway", "Takeaway");
		const showCount = () => {
			const count = takeawaysOn(entry.id).length;
			let name = "Takeaway";
			if (count > 0) name = `Takeaway (${count})`;
			showRailIcon(takeaway, "takeaway", name);
			if (count > 0)
				takeaway.append(
					el(
						"span",
						{ class: "takeaway-count", "aria-hidden": "true" },
						String(count),
					),
				);
		};
		counts.push(showCount);
		showCount();
		takeaway.addEventListener("click", () => open(entry));
		return takeaway;
	}

	// The site's takeaways, except an entry's with a change still on its way, and the page's own version of a takeaway
	// whose save the site refused, which keeps its warning.
	function replace(fresh: AllTakeaways) {
		const next: AllTakeaways = Object.create(null);
		for (const entryId of Object.keys(fresh)) {
			const list = fresh[entryId];
			if (list !== undefined) next[entryId] = list;
		}
		for (const entryId of Object.keys(memory)) {
			if (sender.pending("takeaways", entryId)) {
				const local = memory[entryId];
				if (local !== undefined) next[entryId] = local;
				continue;
			}
			const unsaved = takeawaysOn(entryId).filter((takeaway) =>
				warnings.has(takeaway.id),
			);
			if (unsaved.length === 0) continue;
			const ids = unsaved.map((takeaway) => takeaway.id);
			const others = (next[entryId] || []).filter(
				(takeaway) => !ids.includes(takeaway.id),
			);
			next[entryId] = newestFirst(others.concat(unsaved));
		}
		memory = next;
		redrawCounts();
		draw();
	}

	return { button: button, replace: replace };
}
