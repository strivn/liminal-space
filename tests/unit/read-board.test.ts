// The read board: the page's read marks, and their trip to the site.
import { afterEach, expect, test, vi } from "vitest";
import type { Sender } from "../../site/page/owner.ts";
import { createReadBoard } from "../../site/page/read-board.ts";
import type { ReadState } from "../../site/page/types.ts";

const ID = "arxiv:2601.00001";

// A sender whose answers the test controls; it records each change it was given.
function fakeSender(answers: boolean[], pendingIds: string[] = []) {
	const sent: { route: string; entryId: string; change: object }[] = [];
	const sender: Sender = {
		send: async (route, entryId, change) => {
			sent.push({ route, entryId, change });
			const answer = answers.shift();
			if (answer === undefined) return true;
			return answer;
		},
		pending: (_route, entryId) => pendingIds.includes(entryId),
		moves: () => 0,
	};
	return { sender, sent };
}

function boardOver(readState: ReadState, sender: Sender) {
	const notices: string[] = [];
	const afterChange = vi.fn();
	const afterRollBack = vi.fn();
	const board = createReadBoard(
		readState,
		sender,
		(text) => notices.push(text),
		afterChange,
		afterRollBack,
	);
	return { board, notices, afterChange, afterRollBack };
}

// The answer arrives on a later turn of the event loop.
const settled = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	vi.useRealTimers();
});

test("a read press marks the entry with today's date at once and sends its id, depth and date to the site", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
	const readState: ReadState = Object.create(null);
	const { sender, sent } = fakeSender([true]);
	const { board, afterChange } = boardOver(readState, sender);
	board.press(ID, "abstract");
	expect(readState[ID]).toEqual({ depth: "abstract", date: "2026-09-27" });
	expect(sent).toEqual([
		{
			route: "read",
			entryId: ID,
			change: { id: ID, depth: "abstract", date: "2026-09-27" },
		},
	]);
	expect(afterChange).toHaveBeenCalledWith(ID);
	await settled();
	expect(readState[ID]).toEqual({ depth: "abstract", date: "2026-09-27" });
});

test("pressing the same depth again clears the mark and sends depth null", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
	const readState: ReadState = Object.create(null);
	const { sender, sent } = fakeSender([true, true]);
	const { board } = boardOver(readState, sender);
	board.press(ID, "paper");
	board.press(ID, "paper");
	expect(readState[ID]).toBeUndefined();
	expect(sent[1]).toMatchObject({
		change: { id: ID, depth: null, date: "2026-09-27" },
	});
	await settled();
	expect(readState[ID]).toBeUndefined();
});

test("a read press the site did not store goes back to the previous mark and shows a notice", async () => {
	const readState: ReadState = Object.create(null);
	readState[ID] = { depth: "abstract", date: "2026-09-20" };
	const { sender } = fakeSender([false]);
	const { board, notices, afterRollBack } = boardOver(readState, sender);
	board.press(ID, "paper");
	expect(readState[ID]).toMatchObject({ depth: "paper" });
	await settled();
	expect(readState[ID]).toEqual({ depth: "abstract", date: "2026-09-20" });
	expect(afterRollBack).toHaveBeenCalledTimes(1);
	expect(notices).toHaveLength(1);
});

test("taking in the site's read marks replaces the page's marks, except one the page is still sending", () => {
	const readState: ReadState = Object.create(null);
	readState.pending = { depth: "paper", date: "2026-09-27" };
	readState.stale = { depth: "abstract", date: "2026-09-01" };
	const { sender } = fakeSender([], ["pending"]);
	const { board } = boardOver(readState, sender);
	board.replace({
		pending: { depth: "abstract", date: "2026-09-26" },
		fresh: { depth: "paper", date: "2026-09-25" },
	});
	expect(readState.pending).toEqual({ depth: "paper", date: "2026-09-27" });
	expect(readState.stale).toBeUndefined();
	expect(readState.fresh).toEqual({ depth: "paper", date: "2026-09-25" });
});
