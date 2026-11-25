// Shaped my thinking: the mark in the icon rail's own band, and the note under each marked paper in Selected.
import type { StandoutChange } from "../../shared/owner-protocol.ts";
import { jakartaToday } from "./days.ts";
import { railToggles } from "./icons.ts";
import { type Sender, sendOrRollBack } from "./owner.ts";
import { SELECTED_TEXT } from "./selected.ts";
import { takeSiteState } from "./state.ts";
import type { Entry, Standouts } from "./types.ts";

// What createStandoutBoard hands the rest of the page.
export type StandoutBoard = {
	toggles: (entry: Entry) => HTMLElement;
	marks: () => Standouts;
	setNote: (id: string, note: string) => void;
	replace: (fresh: Standouts) => void;
	// Runs after the marks changed, by a press or a state read.
	onChange: (listener: () => void) => void;
};

// A copy of the marks, each its own object, in an object without a prototype, so an entry id "__proto__" is an
// ordinary key.
function copyMarks(marks: Standouts): Standouts {
	const copy: Standouts = Object.create(null);
	for (const id of Object.keys(marks)) {
		const mark = marks[id];
		if (mark !== undefined) copy[id] = { date: mark.date, note: mark.note };
	}
	return copy;
}

// The owner's marks on papers and their notes. `saved` is the site's marks; each press and each note goes to the site
// through `sender`, and one the site refuses is undone and `notice` says so. An unmarked paper keeps its note, which
// comes back with the next mark, as the site keeps it. replace(fresh) takes the site's marks when the page reads its
// state again; a paper with a change still on its way keeps what the page shows.
export function createStandoutBoard(
	saved: Standouts,
	sender: Sender,
	notice: (text: string) => void,
): StandoutBoard {
	let marks = copyMarks(saved);
	let siteMarks = copyMarks(saved);
	const keptNotes = new Map<string, string>(); // an unmarked paper's note
	const views: (() => void)[] = []; // each entry's toggle redraw
	const listeners: (() => void)[] = [];

	function changed() {
		for (const showPressed of views) showPressed();
		for (const listener of listeners) listener();
	}

	// Send a change; when the site doesn't save it, and no later change to the paper is still on its way, the paper
	// goes back to what the site holds.
	function send(id: string, change: StandoutChange, stored: () => void) {
		sendOrRollBack(
			sender,
			"standouts",
			id,
			change,
			{
				stored: stored,
				superseded: () => sender.pending("standouts", id),
				rollBack: () => {
					delete marks[id];
					const siteMark = siteMarks[id];
					if (siteMark !== undefined)
						marks[id] = { date: siteMark.date, note: siteMark.note };
					changed();
				},
			},
			notice,
			"A mark or note not saved:",
		);
	}

	function press(id: string) {
		const current = marks[id];
		const date = jakartaToday(new Date());
		if (current !== undefined) {
			keptNotes.set(id, current.note);
			delete marks[id];
			send(id, { id: id, marked: false, date: date }, () => {
				delete siteMarks[id];
			});
		} else {
			const note = keptNotes.get(id) ?? "";
			marks[id] = { date: date, note: note };
			send(id, { id: id, marked: true, date: date }, () => {
				siteMarks[id] = { date: date, note: note };
			});
		}
		changed();
	}

	function setNote(id: string, note: string) {
		const current = marks[id];
		if (current === undefined || current.note === note) return;
		current.note = note;
		send(id, { id: id, note: note }, () => {
			const site = siteMarks[id];
			if (site !== undefined) site.note = note;
		});
	}

	function toggles(entry: Entry) {
		const group = railToggles(
			[
				{
					icon: "shaped",
					name: SELECTED_TEXT.mark,
					pressed: () => marks[entry.id] !== undefined,
					press: () => press(entry.id),
				},
			],
			views,
		);
		return group;
	}

	function replace(fresh: Standouts) {
		marks = takeSiteState(
			fresh,
			marks,
			(id) => sender.pending("standouts", id),
			(mark) => ({ date: mark.date, note: mark.note }),
		);
		siteMarks = copyMarks(fresh);
		changed();
	}

	return {
		toggles: toggles,
		marks: () => marks,
		setNote: setNote,
		replace: replace,
		onChange: (listener) => {
			listeners.push(listener);
		},
	};
}
