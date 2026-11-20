// The OK, Like and Dislike toggles, the icon rail's last group in the left column.
import type {
	Feedback,
	FeedbackChange,
	FeedbackMark,
} from "../../shared/owner-protocol.ts";
import { jakartaToday } from "./days.ts";
import { railToggles } from "./icons.ts";
import { type Sender, sendOrRollBack } from "./owner.ts";
import { takeSiteState } from "./state.ts";
import type { Entry, FeedbackMarks } from "./types.ts";

// What createFeedbackBoard hands the rest of the page.
export type FeedbackBoard = {
	toggles: (entry: Entry) => HTMLElement;
	replace: (fresh: FeedbackMarks) => void;
};

// Each toggle's mark and what it says.
const FEEDBACK_TOGGLES: { mark: Feedback; name: string }[] = [
	{ mark: "ok", name: "OK" },
	{ mark: "like", name: "Like" },
	{ mark: "dislike", name: "Dislike" },
];

// A copy of the marks, each its own object, in an object without a prototype, so an entry id "__proto__" is an
// ordinary key.
function copyMarks(marks: FeedbackMarks): FeedbackMarks {
	const copy: FeedbackMarks = Object.create(null);
	for (const id of Object.keys(marks)) {
		const mark = marks[id];
		if (mark !== undefined) copy[id] = { mark: mark.mark, date: mark.date };
	}
	return copy;
}

// Dislike, OK and Like on every entry: one mark at most, a press on another replaces it, a press on the one shown
// clears it. A disliked entry stays on the page. `saved` is the site's marks; each press goes to the site through `sender`,
// and one the site refuses is undone and `notice` says so. replace(fresh) takes the site's marks when the page reads
// its state again; an entry with a press still on its way keeps what the page shows.
export function createFeedbackBoard(
	saved: FeedbackMarks,
	sender: Sender,
	notice: (text: string) => void,
): FeedbackBoard {
	// The page's marks, changed at once by a press, and the marks the site is known to hold, for undoing a refused one.
	let marks = copyMarks(saved);
	let siteMarks = copyMarks(saved);
	const views: (() => void)[] = []; // each entry's toggle redraw

	function redraw() {
		for (const showPressed of views) showPressed();
	}

	// Send an entry's mark as it now is. When the site doesn't save it, and no later press on the entry is still on its
	// way, the mark goes back to what the site holds, and the page says why.
	function send(id: string) {
		const current = marks[id];
		let mark: Feedback | null = null;
		if (current !== undefined) mark = current.mark;
		const change: FeedbackChange = {
			id: id,
			mark: mark,
			date: jakartaToday(new Date()),
		};
		sendOrRollBack(
			sender,
			"feedback",
			id,
			change,
			{
				stored: () => {
					// The site now holds what this press sent.
					delete siteMarks[id];
					if (change.mark !== null)
						siteMarks[id] = { mark: change.mark, date: change.date };
				},
				superseded: () => sender.pending("feedback", id),
				rollBack: () => {
					delete marks[id];
					const siteMark = siteMarks[id];
					if (siteMark !== undefined)
						marks[id] = { mark: siteMark.mark, date: siteMark.date };
					redraw();
				},
			},
			notice,
			"A like or dislike not drawn:",
		);
	}

	// A press on the mark shown clears it; a press on the other mark replaces it.
	function press(id: string, mark: Feedback) {
		const current = marks[id];
		if (current !== undefined && current.mark === mark) {
			delete marks[id];
		} else {
			const pressed: FeedbackMark = {
				mark: mark,
				date: jakartaToday(new Date()),
			};
			marks[id] = pressed;
		}
		send(id);
		redraw();
	}

	function toggles(entry: Entry) {
		const feedbackToggles = FEEDBACK_TOGGLES.map((toggle) => ({
			icon: toggle.mark,
			name: toggle.name,
			pressed: () => {
				const current = marks[entry.id];
				return current !== undefined && current.mark === toggle.mark;
			},
			press: () => press(entry.id, toggle.mark),
		}));
		const group = railToggles(feedbackToggles, views);
		// style.css draws a hairline between OK and Like in this group.
		group.classList.add("entry__rail-group--divided");
		return group;
	}

	function replace(fresh: FeedbackMarks) {
		marks = takeSiteState(
			fresh,
			marks,
			(id) => sender.pending("feedback", id),
			(mark) => ({ mark: mark.mark, date: mark.date }),
		);
		siteMarks = copyMarks(fresh);
		redraw();
	}

	return { toggles: toggles, replace: replace };
}
