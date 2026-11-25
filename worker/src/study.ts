// Store an entry's Chinese study pushed by sync.ts push-study.
import { isJsonObject } from "../../shared/narrow.ts";
import {
	MAX_STUDY_BYTES,
	type StudyAnswer,
	studyProblems,
} from "../../shared/study-protocol.ts";
import { counter, countOne } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import {
	BodyProblem,
	json,
	readJson,
	refuse,
	refuseBody,
	tryAgain,
} from "./respond.ts";

const ENTRY_SQL = "SELECT json FROM entries WHERE id = ?1";
const REPLACE_SQL =
	"INSERT INTO study (id, json, updated) VALUES (?1, ?2, ?3) " +
	"ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated";

// POST /liminal-space/api/sync/study: a StudyPush in, a StudyAnswer out (shared/study-protocol.ts).
export async function answerStudyPush(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request, MAX_STUDY_BYTES);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		return refuseBody(log, error);
	}
	if (!isJsonObject(body) || !isJsonObject(body.study)) {
		return refuse(log, 400, "bad request", 'body has no "study" object');
	}
	const study = body.study;
	const id = typeof study.id === "string" ? study.id : null;
	const refused = (problems: string[]): Response => {
		const answer: StudyAnswer = {
			id: id,
			outcome: "refused",
			problems: problems,
		};
		return json(answer);
	};
	if (id === null) {
		return refused(["the study has no id"]);
	}

	const count = counter(log);
	try {
		const entry = await countOne(
			env.DB.prepare(ENTRY_SQL).bind(id).all<{ json: string }>(),
			count,
		);
		const stored = entry.results[0];
		if (stored === undefined) {
			return refused(["the database holds no entry with the study's id"]);
		}
		const parsed: unknown = JSON.parse(stored.json);
		if (!isJsonObject(parsed)) {
			throw new Error(`the stored entry ${id} is not an object`);
		}
		const problems = studyProblems(study, parsed);
		if (problems.length > 0) {
			return refused(problems);
		}
		await countOne(
			env.DB.prepare(REPLACE_SQL)
				.bind(id, JSON.stringify(study), new Date().toISOString())
				.run(),
			count,
		);
		const answer: StudyAnswer = { id: id, outcome: "stored" };
		return json(answer);
	} catch (error) {
		return tryAgain(log, "study push failed", error);
	}
}
