// POST /liminal-space/api/owner/ask: answer a thread's last @Claude comment with Claude's
// reply, streamed to the page and saved into the thread. The owner checks run before this, as for every owner change.
import { isJsonObject, type JsonObject } from "../../shared/narrow.ts";
import {
	type AskRefusal,
	MAX_ID_LENGTH,
	MAX_OWNER_BODY_BYTES,
	mentionsClaude,
} from "../../shared/owner-protocol.ts";
import { type AnswerOutcome, type AskContext, streamAnswer } from "./claude.ts";
import { counter, runBatch } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import { BodyProblem, readJson } from "./respond.ts";

// The status each refusal answers with.
const REFUSAL_STATUS: Record<AskRefusal, number> = {
	notSetUp: 503,
	budget: 402,
	failed: 502,
};

// The thread's place, through the primary key and the entry id, so another entry's thread is never read.
const SELECT_THREAD =
	"SELECT field, passage FROM threads WHERE id = ?1 AND entry_id = ?2";
// The thread's comments in the order they were saved, through comments_thread.
const SELECT_COMMENTS =
	"SELECT id, text, author FROM comments WHERE thread_id = ?1 ORDER BY rowid";
// The entry's stored JSON, through the primary key.
const SELECT_ENTRY = "SELECT json FROM entries WHERE id = ?1";
// Claude's reply, saved only while the thread's last comment is still the question it answered: a question deleted
// or already answered meanwhile (a second Retry) takes no second reply.
const INSERT_REPLY =
	"INSERT INTO comments (id, thread_id, text, created, edited, author) " +
	"SELECT ?1, ?2, ?3, ?4, NULL, 'claude' " +
	"WHERE (SELECT id FROM comments WHERE thread_id = ?2 ORDER BY rowid DESC LIMIT 1) = ?5";

// An answer that holds only a plain-text reason: a 400 states what is wrong, a refusal is its AskRefusal's name.
function plain(log: RequestLog, status: number, body: string, reason: string) {
	log.reason = reason;
	return new Response(body, {
		status: status,
		headers: { "Cache-Control": "no-store" },
	});
}

// A refusal the page maps to its ASK_MESSAGES text.
function refusal(log: RequestLog, name: AskRefusal, reason: string) {
	return plain(log, REFUSAL_STATUS[name], name, reason);
}

// The two ids of an AskRequest, or null for a body that holds anything else.
function askIdsOf(body: unknown): { entryId: string; threadId: string } | null {
	if (!isJsonObject(body)) {
		return null;
	}
	const { entryId, threadId } = body;
	for (const id of [entryId, threadId]) {
		if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) {
			return null;
		}
	}
	return { entryId: String(entryId), threadId: String(threadId) };
}

// An address as text when it is an http or https one, else null.
function httpAddress(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	try {
		const address = new URL(value);
		if (address.protocol === "https:" || address.protocol === "http:") {
			return address.href;
		}
	} catch {
		return null;
	}
	return null;
}

// The addresses Claude may fetch for the paper's full text: the arXiv HTML and PDF for an arXiv entry, else the
// entry's own PDF link, else its address.
function paperUrlsOf(entryId: string, entry: JsonObject): string[] {
	if (entryId.startsWith("arxiv:")) {
		const id = entryId.slice("arxiv:".length);
		return [`https://arxiv.org/html/${id}`, `https://arxiv.org/pdf/${id}`];
	}
	if (Array.isArray(entry.links)) {
		for (const link of entry.links) {
			if (isJsonObject(link) && link.label === "PDF") {
				const address = httpAddress(link.url);
				if (address !== null) {
					return [address];
				}
			}
		}
	}
	const address = httpAddress(entry.url);
	if (address !== null) {
		return [address];
	}
	return [];
}

// A stored field as text, or null when the entry has none.
function textOrNull(value: unknown): string | null {
	if (typeof value === "string" && value !== "") {
		return value;
	}
	return null;
}

// Why a thread can't be asked about, or the context Claude is sent. The thread's last comment must be the owner's and
// mention @Claude, which also means Claude has not answered it.
function contextOf(
	entryId: string,
	place: Record<string, unknown> | undefined,
	comments: Record<string, unknown>[],
	entryJson: unknown,
): AskContext | string {
	if (place === undefined) {
		return "no such thread";
	}
	if (typeof entryJson !== "string") {
		return "no such entry";
	}
	const entry: unknown = JSON.parse(entryJson);
	if (!isJsonObject(entry) || typeof entry.title !== "string") {
		return "the entry can't be read";
	}
	const last = comments.at(-1);
	if (last === undefined) {
		return "the thread has no comment";
	}
	if (last.author === "claude") {
		return "Claude already answered the thread's last comment";
	}
	if (!mentionsClaude(String(last.text))) {
		return "the thread's last comment doesn't mention @Claude";
	}
	let passage: AskContext["passage"] = null;
	if (
		(place.field === "title" || place.field === "abstract") &&
		typeof place.passage === "string"
	) {
		passage = { field: place.field, text: place.passage };
	}
	let authors: string[] = [];
	if (Array.isArray(entry.authors)) {
		authors = entry.authors.filter((name) => typeof name === "string");
	}
	return {
		entryId: entryId,
		title: entry.title,
		authors: authors,
		venue: textOrNull(entry.venue),
		abstract: textOrNull(entry.abstract),
		passage: passage,
		thread: comments.map((comment) => ({
			author: comment.author === "claude" ? "claude" : "owner",
			text: String(comment.text),
		})),
		paperUrls: paperUrlsOf(entryId, entry),
	};
}

// Save Claude's reply after the thread's last comment; nothing is saved when the thread has moved on from `questionId`.
async function saveReply(
	env: Env,
	threadId: string,
	questionId: string,
	text: string,
): Promise<void> {
	await env.DB.prepare(INSERT_REPLY)
		.bind(
			crypto.randomUUID(),
			threadId,
			text,
			new Date().toISOString(),
			questionId,
		)
		.run();
}

// What happens once Claude's answer ends, whether or not the page is still there: save the reply and close the stream
// to the page, or end the stream in an error so the page sees a broken answer, never a short one that looks whole.
async function finish(
	outcome: Promise<AnswerOutcome>,
	env: Env,
	threadId: string,
	questionId: string,
	writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
	try {
		const answer = await outcome;
		if (!answer.ok) {
			throw new Error(answer.refusal);
		}
		await saveReply(env, threadId, questionId, answer.text);
		await writer.close();
	} catch (error) {
		// Only the error's name: its message could quote the reply. A page that has gone makes abort() fail too.
		let name = "Error";
		if (error instanceof Error) {
			name = error.name;
		}
		console.log(JSON.stringify({ claude: "not saved", errorName: name }));
		await writer.abort(error).catch(() => {});
	}
}

// Read the AskRequest body, read the thread and entry from the database, refuse what can't be asked, then stream
// Claude's reply as text/plain and save it as a "claude" comment when it ends, through ctx.waitUntil when the page
// has gone. Refusals answer before any reply text: 503 notSetUp, 402 budget, 502 failed, and 400
// with the reason for a body or thread it can't use.
export async function answerAsk(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request, MAX_OWNER_BODY_BYTES);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		if (error.status === 413) {
			return plain(log, 413, "body is too large", "body is too large");
		}
		return plain(log, 400, error.message, error.message);
	}
	const ids = askIdsOf(body);
	if (ids === null) {
		return plain(
			log,
			400,
			"body is not an entry id and a thread id",
			"body is not an entry id and a thread id",
		);
	}
	if (!env.ANTHROPIC_API_KEY) {
		return refusal(log, "notSetUp", "no Anthropic key is set");
	}

	// The thread, its comments and the entry, read together as one moment's state.
	const count = counter(log);
	let answers: D1Result<Record<string, unknown>>[];
	try {
		answers = await runBatch(
			env.DB,
			[
				env.DB.prepare(SELECT_THREAD).bind(ids.threadId, ids.entryId),
				env.DB.prepare(SELECT_COMMENTS).bind(ids.threadId),
				env.DB.prepare(SELECT_ENTRY).bind(ids.entryId),
			],
			count,
		);
	} catch (error) {
		// The failed refusal, not 503: the page reads 503 as Claude not being set up.
		let reason = "thread read failed";
		if (error instanceof Error) {
			reason = `${reason}: ${error.message}`;
		}
		return refusal(log, "failed", reason);
	}
	const rows = (statement: number) => answers[statement]?.results ?? [];
	const comments = rows(1);
	const context = contextOf(
		ids.entryId,
		rows(0)[0],
		comments,
		rows(2)[0]?.json,
	);
	if (typeof context === "string") {
		return plain(log, 400, context, context);
	}

	// Ask Claude, and wait for its first text or its end: only then is the answer's status known.
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	let sawText = false;
	let firstText = () => {};
	const started = new Promise<null>((resolve) => {
		firstText = () => resolve(null);
	});
	const outcome = streamAnswer(
		{ baseUrl: env.ANTHROPIC_API, apiKey: env.ANTHROPIC_API_KEY },
		context,
		(text) => {
			// A page that has gone makes write() fail; the reply is still saved.
			writer.write(encoder.encode(text)).catch(() => {});
			if (!sawText) {
				sawText = true;
				firstText();
			}
		},
	);
	const ended = await Promise.race([started, outcome]);
	if (ended !== null) {
		const name = ended.ok ? "failed" : ended.refusal;
		return refusal(log, name, `Claude's answer ended with no text: ${name}`);
	}

	// The question is the thread's last comment, whose id the reply is saved after.
	const questionId = String(comments.at(-1)?.id);
	ctx.waitUntil(finish(outcome, env, ids.threadId, questionId, writer));
	return new Response(readable, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store, no-transform",
			"Content-Encoding": "identity",
		},
	});
}
