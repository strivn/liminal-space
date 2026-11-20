// Why a fetch rejected, in words for a message.
import { errorCode } from "../../shared/narrow.ts";

// The cause says more than "fetch failed": a code such as ENOTFOUND, else a message such as "bad port", else the
// error's own message. A thrown value that isn't an Error has no message: undefined, which prints as "undefined".
export function failureReason(error: unknown): string | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}
	if (!error.cause) {
		return error.message;
	}
	let causeMessage: string | undefined;
	if (error.cause instanceof Error) {
		causeMessage = error.cause.message;
	}
	return errorCode(error.cause) || causeMessage || error.message;
}

// A rejected fetch in words that finish "<source> ...": "gave no answer within 30 seconds" when the time limit ended
// it, else "could not be reached (ENOTFOUND)".
export function fetchProblem(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && error.name === "TimeoutError") {
		return `gave no answer within ${timeoutMs / 1000} seconds`;
	}
	return `could not be reached (${failureReason(error)})`;
}
