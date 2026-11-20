// The page's read marks: the one place that toggles a mark, sends it to the site and undoes it when the site refuses.
import type { Depth, ReadChange } from "../../shared/owner-protocol.ts";
import { jakartaToday } from "./days.ts";
import { type Sender, sendOrRollBack } from "./owner.ts";
import { copyReadState, toggleRead } from "./state.ts";
import type { ReadState } from "./types.ts";

// What the page calls: press toggles a mark and sends it; replace takes the site's marks.
export type ReadBoard = {
	press: (id: string, depth: Depth) => void;
	replace: (fresh: ReadState) => void;
};

// Changes `readState`, which the page shares, in place; afterChange follows a press, afterRollBack an undone one.
export function createReadBoard(
	readState: ReadState,
	sender: Sender,
	notice: (text: string) => void,
	afterChange: (id: string) => void,
	afterRollBack: () => void,
): ReadBoard {
	// The marks the site is known to hold, for undoing a refused press.
	let siteRead = copyReadState(readState);

	// Send an entry's mark as it now is.
	function send(id: string) {
		const mark = readState[id];
		let depth: Depth | null = null;
		if (mark !== undefined) depth = mark.depth;
		const change: ReadChange = {
			id: id,
			depth: depth,
			date: jakartaToday(new Date()),
		};
		sendOrRollBack(
			sender,
			"read",
			id,
			change,
			{
				stored: () => {
					// The site now holds what this press sent.
					delete siteRead[id];
					if (change.depth !== null)
						siteRead[id] = { depth: change.depth, date: change.date };
				},
				superseded: () => sender.pending("read", id),
				rollBack: () => {
					delete readState[id];
					const siteMark = siteRead[id];
					if (siteMark !== undefined)
						readState[id] = { depth: siteMark.depth, date: siteMark.date };
					afterRollBack();
				},
			},
			notice,
			"A read change not drawn:",
		);
	}

	// Toggle the mark at once, then send it.
	function press(id: string, depth: Depth) {
		toggleRead(readState, id, depth, jakartaToday(new Date()));
		send(id);
		afterChange(id);
	}

	// Take the site's marks, keeping those of entries with a press still on its way.
	function replace(fresh: ReadState) {
		for (const id of Object.keys(readState)) {
			if (!sender.pending("read", id)) delete readState[id];
		}
		for (const id of Object.keys(fresh)) {
			const mark = fresh[id];
			if (mark !== undefined && !sender.pending("read", id))
				readState[id] = { depth: mark.depth, date: mark.date };
		}
		siteRead = copyReadState(fresh);
	}

	return { press: press, replace: replace };
}
