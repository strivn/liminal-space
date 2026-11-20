// The page's side of asking Claude: one POST to the ask route, read as a stream.
import type { AskRefusal } from "../../shared/owner-protocol.ts";
import { postChange } from "./owner.ts";

// How asking ended: Claude's whole reply, or the refusal whose ASK_MESSAGES text the thread shows.
export type AskOutcome =
	| { ok: true; text: string }
	| { ok: false; refusal: AskRefusal };

// The refusal each status the ask route answers with stands for; any other status or no answer is a failed answer.
const REFUSAL_BY_STATUS: Record<number, AskRefusal> = {
	503: "notSetUp",
	402: "budget",
	502: "failed",
};

// Ask Claude about a thread whose last comment is the owner's @Claude question; onText gets the reply so far each
// time a piece arrives, so the thread can show it while Claude writes.
export async function askClaude(
	entryId: string,
	threadId: string,
	onText: (soFar: string) => void,
): Promise<AskOutcome> {
	const response = await postChange(
		"ask",
		JSON.stringify({ entryId: entryId, threadId: threadId }),
	);
	if (response === null) return { ok: false, refusal: "failed" };
	if (response.status !== 200 || response.body === null) {
		return {
			ok: false,
			refusal: REFUSAL_BY_STATUS[response.status] || "failed",
		};
	}

	// The reply as it arrives. A stream that breaks is a failed answer: the Worker saves nothing then, and a short
	// reply must never pass for a whole one.
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			// biome-ignore lint/performance/noAwaitInLoops: a stream reads in order
			const piece = await reader.read();
			if (piece.done) break;
			text += decoder.decode(piece.value, { stream: true });
			onText(text);
		}
		text += decoder.decode();
	} catch {
		return { ok: false, refusal: "failed" };
	}
	if (text.trim() === "") return { ok: false, refusal: "failed" };
	return { ok: true, text: text };
}
