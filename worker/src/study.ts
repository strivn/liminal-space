// Store an entry's Chinese study pushed by sync.ts push-study.
import type { Env } from "./env.ts";

// POST /liminal-space/api/sync/study: a StudyPush in, a StudyAnswer out (shared/study-protocol.ts).
export async function answerStudyPush(
	_request: Request,
	_env: Env,
	_ctx: ExecutionContext,
): Promise<Response> {
	throw new Error("not implemented");
}
