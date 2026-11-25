// The owner routes' writes: one row per entry, thread, comment or takeaway, so two devices never overwrite each
// other. Every statement's cost goes to `count`, as push does, for the request's log line. Each function runs at most
// 50 D1 statements.
import type {
	CommentsChange,
	FeedbackChange,
	PageComment,
	ReadChange,
	StandoutChange,
	TagsChange,
	TakeawayChange,
	TakeawaySource,
} from "../../../shared/owner-protocol.ts";
import {
	countOne,
	MAX_BOUND_VALUES,
	MAX_STATEMENTS,
	type QueryCost,
	runBatch,
} from "../d1.ts";
import { BodyProblem } from "../respond.ts";

// Rows of `width` values each as INSERT statements of at most MAX_BOUND_VALUES bound values: `head` is the
// statement up to VALUES, `tail` what follows the rows.
function multiRowInserts(
	db: D1Database,
	head: string,
	tail: string,
	width: number,
	rows: unknown[][],
): D1PreparedStatement[] {
	const perStatement = Math.floor(MAX_BOUND_VALUES / width);
	const marks = `(${new Array(width).fill("?").join(", ")})`;
	const statements: D1PreparedStatement[] = [];
	for (let start = 0; start < rows.length; start += perStatement) {
		const chunk = rows.slice(start, start + perStatement);
		const values = chunk.flat();
		const sql = `${head} VALUES ${new Array(chunk.length).fill(marks).join(", ")} ${tail}`;
		statements.push(db.prepare(sql).bind(...values));
	}
	return statements;
}

// A read mark: written over the entry's mark through the primary key.
const UPSERT_READ =
	"INSERT INTO read_state (entry_id, depth, date) VALUES (?1, ?2, ?3) " +
	"ON CONFLICT(entry_id) DO UPDATE SET depth = excluded.depth, date = excluded.date";
const DELETE_READ = "DELETE FROM read_state WHERE entry_id = ?1";
// A Dislike, OK or Like: written over the entry's mark through the primary key, so an entry holds one at most.
const UPSERT_FEEDBACK =
	"INSERT INTO feedback (entry_id, mark, date) VALUES (?1, ?2, ?3) " +
	"ON CONFLICT(entry_id) DO UPDATE SET mark = excluded.mark, date = excluded.date";
const DELETE_FEEDBACK = "DELETE FROM feedback WHERE entry_id = ?1";
// Standouts: mark, unmark, note.
const MARK_STANDOUT =
	"INSERT INTO standouts (entry_id, date) SELECT id, ?2 FROM entries WHERE id = ?1 " +
	"ON CONFLICT(entry_id) DO UPDATE SET date = excluded.date";
const UNMARK_STANDOUT = "UPDATE standouts SET date = NULL WHERE entry_id = ?1";
const SET_NOTE =
	"UPDATE standouts SET note = ?2 WHERE entry_id = ?1 AND date IS NOT NULL";
// A takeaway saved from the page, through the primary key: a new one is stored with its source; one already stored is
// an edit, which changes only its words and edited, so it keeps its entry, created and source. saveTakeaway reads the
// stored entry first (TAKEAWAY_ENTRY) and refuses an edit that names another one.
const TAKEAWAY_ENTRY = "SELECT entry_id FROM takeaways WHERE id = ?1";
const UPSERT_TAKEAWAY =
	"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) " +
	"VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
	"ON CONFLICT(id) DO UPDATE SET takeaway = excluded.takeaway, recall_question = excluded.recall_question, " +
	"edited = excluded.edited";
const DELETE_TAKEAWAY = "DELETE FROM takeaways WHERE id = ?1 AND entry_id = ?2";
// One tag of an entry, set through the primary key; the other column keeps what the row holds (0 for a new row).
const UPSERT_TO_READ =
	"INSERT INTO tags (entry_id, to_read, learn_first) VALUES (?1, ?2, 0) " +
	"ON CONFLICT(entry_id) DO UPDATE SET to_read = excluded.to_read";
const UPSERT_LEARN_FIRST =
	"INSERT INTO tags (entry_id, to_read, learn_first) VALUES (?1, 0, ?2) " +
	"ON CONFLICT(entry_id) DO UPDATE SET learn_first = excluded.learn_first";
// An entry whose tags are both off has no row.
const DELETE_TAGS_OFF =
	"DELETE FROM tags WHERE entry_id = ?1 AND to_read = 0 AND learn_first = 0";
// A thread's place, written once through the primary key: a thread already stored keeps its entry, place and created
// (its first saved comment's time, or the time it was highlighted). saveComments reads the stored entry first
// (THREAD_ENTRY) and refuses a change that names another one, so its comments never join another entry's thread.
const THREAD_ENTRY = "SELECT entry_id FROM threads WHERE id = ?1";
const INSERT_THREAD =
	"INSERT INTO threads (id, entry_id, field, passage, occurrence, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
	"ON CONFLICT(id) DO NOTHING";
// Comments of one thread, in order. A comment already stored keeps its row (so its place among the replies), its
// created and its author; only its text and edited change, and only when it is stored in the same thread.
const INSERT_COMMENTS_HEAD =
	"INSERT INTO comments (id, thread_id, text, created, edited, author)";
const SAVE_COMMENTS_TAIL =
	"ON CONFLICT(id) DO UPDATE SET text = excluded.text, edited = excluded.edited " +
	"WHERE comments.thread_id = excluded.thread_id";
// A thread made a highlight (1) or an ordinary thread again (0), through the primary key.
const SET_HIGHLIGHT = "UPDATE threads SET highlight = ?2 WHERE id = ?1";
// A thread with no comments left that isn't a highlight, found through the primary key and the comments_thread index.
const DELETE_EMPTY_THREAD =
	"DELETE FROM threads WHERE id = ?1 AND highlight = 0 AND NOT EXISTS (SELECT 1 FROM comments WHERE thread_id = ?1)";
// Bound values per row of the comments table.
const COMMENT_WIDTH = 6;

// Comments of the thread `threadId` as rows for INSERT_COMMENTS_HEAD, all the owner's: this route writes no other.
function commentRows(threadId: string, comments: PageComment[]): unknown[][] {
	const rows: unknown[][] = [];
	for (const comment of comments) {
		rows.push([
			comment.id,
			threadId,
			comment.text,
			comment.created,
			comment.edited,
			"owner",
		]);
	}
	return rows;
}

// A tag as the tags table stores it: 1 for on, 0 for off.
function tagValue(on: boolean | undefined) {
	if (on) {
		return 1;
	}
	return 0;
}

// POST read: set or clear one entry's read mark.
export async function saveRead(
	db: D1Database,
	change: ReadChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	if (change.depth === null) {
		await countOne(db.prepare(DELETE_READ).bind(change.id).run(), count);
		return;
	}
	await countOne(
		db.prepare(UPSERT_READ).bind(change.id, change.depth, change.date).run(),
		count,
	);
}

// POST tags: set one tag of an entry, leaving the other as stored; a row left with both off is removed. One batch, so
// the row is never seen half-changed.
export async function saveTags(
	db: D1Database,
	change: TagsChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	let upsert = UPSERT_TO_READ;
	if (change.tag === "learnFirst") {
		upsert = UPSERT_LEARN_FIRST;
	}
	await runBatch(
		db,
		[
			db.prepare(upsert).bind(change.id, tagValue(change.on)),
			db.prepare(DELETE_TAGS_OFF).bind(change.id),
		],
		count,
	);
}

// POST feedback: set an entry's Dislike, OK or Like over the one it had, or clear it.
export async function saveFeedback(
	db: D1Database,
	change: FeedbackChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	if (change.mark === null) {
		await countOne(db.prepare(DELETE_FEEDBACK).bind(change.id).run(), count);
		return;
	}
	await countOne(
		db.prepare(UPSERT_FEEDBACK).bind(change.id, change.mark, change.date).run(),
		count,
	);
}

// POST standouts.
export async function saveStandout(
	db: D1Database,
	change: StandoutChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	if ("note" in change) {
		const answer = await countOne(
			db.prepare(SET_NOTE).bind(change.id, change.note).run(),
			count,
		);
		if (answer.meta.changes === 0) {
			throw new BodyProblem("the paper is not marked");
		}
		return;
	}
	if (!change.marked) {
		await countOne(db.prepare(UNMARK_STANDOUT).bind(change.id).run(), count);
		return;
	}
	const answer = await countOne(
		db.prepare(MARK_STANDOUT).bind(change.id, change.date).run(),
		count,
	);
	if (answer.meta.changes === 0) {
		throw new BodyProblem("no stored entry has that id");
	}
}

// The entry the row `select` finds by primary key names (one row read), or null when no row has that id.
async function storedEntryOf(
	db: D1Database,
	select: string,
	id: string,
	count: (cost: QueryCost) => void,
): Promise<string | null> {
	const answer = await countOne(
		db.prepare(select).bind(id).all<{ entry_id: unknown }>(),
		count,
	);
	const row = answer.results[0];
	if (row === undefined) {
		return null;
	}
	return String(row.entry_id);
}

// POST takeaways: save or delete one takeaway by its id, through the primary key. A delete reaches only the takeaway
// stored on this entry; a save of a takeaway stored on another entry is refused (400), so an edit never changes
// another entry's takeaway.
export async function saveTakeaway(
	db: D1Database,
	change: TakeawayChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	if ("delete" in change) {
		await countOne(
			db.prepare(DELETE_TAKEAWAY).bind(change.delete, change.entryId).run(),
			count,
		);
		return;
	}
	const takeaway = change.save;
	const stored = await storedEntryOf(db, TAKEAWAY_ENTRY, takeaway.id, count);
	if (stored !== null && stored !== change.entryId) {
		throw new BodyProblem("the takeaway belongs to another entry");
	}
	await countOne(
		db
			.prepare(UPSERT_TAKEAWAY)
			.bind(
				takeaway.id,
				change.entryId,
				takeaway.text,
				takeaway.question,
				takeaway.created,
				takeaway.edited,
				"page",
			)
			.run(),
		count,
	);
}

// propose_takeaway: store a new takeaway on the entry `entryId` names, from `source`, created now, and answer the
// entry's title; null, and nothing stored, when no entry has that id. One batch: an INSERT that takes the entry's id
// from its row through the primary key, so it stores nothing for an unknown id, then the title through the same key.
export async function proposeTakeaway(
	db: D1Database,
	entryId: string,
	text: string,
	question: string,
	source: TakeawaySource,
	count: (cost: QueryCost) => void,
): Promise<string | null> {
	const answers = await runBatch<{ title: unknown }>(
		db,
		[
			db
				.prepare(
					"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) " +
						"SELECT ?1, id, ?3, ?4, ?5, NULL, ?6 FROM entries WHERE id = ?2",
				)
				.bind(
					crypto.randomUUID(),
					entryId,
					text,
					question,
					new Date().toISOString(),
					source,
				),
			db
				.prepare(
					"SELECT json_extract(json, '$.title') AS title FROM entries WHERE id = ?1",
				)
				.bind(entryId),
		],
		count,
	);
	const found = answers[1];
	if (found === undefined) {
		throw new Error("D1 answered fewer statements than it was given");
	}
	const row = found.results[0];
	if (row === undefined) {
		return null;
	}
	return String(row.title);
}

// POST comments: save and delete comments of one thread, each by its id, so a comment this body doesn't name is never
// touched. The thread is stored with its place on its first save, or when it is highlighted; saved comments keep the
// order they were first saved in; deletes reach only this thread's comments; a thread left with no comments goes,
// unless it is a highlight. A thread already stored on another entry is refused (400) before anything is written.
// One batch for the writes, so the thread is never stored half-changed.
export async function saveComments(
	db: D1Database,
	change: CommentsChange,
	count: (cost: QueryCost) => void,
): Promise<void> {
	const thread = change.thread;
	const stored = await storedEntryOf(db, THREAD_ENTRY, thread.id, count);
	if (stored !== null && stored !== change.entryId) {
		throw new BodyProblem("the thread belongs to another entry");
	}
	const statements: D1PreparedStatement[] = [];

	// The thread's place, when the site doesn't hold the thread yet: created at the first comment it saves, or now
	// when it is highlighted without one. Then its flag, when the body sets it.
	const first = change.save[0];
	let created: string | null = null;
	if (first !== undefined) {
		created = first.created;
	} else if (change.highlight === true) {
		created = new Date().toISOString();
	}
	if (created !== null) {
		statements.push(
			db
				.prepare(INSERT_THREAD)
				.bind(
					thread.id,
					change.entryId,
					thread.field,
					thread.passage,
					thread.occurrence,
					created,
				),
		);
	}
	if (change.highlight !== undefined) {
		let flag = 0;
		if (change.highlight) {
			flag = 1;
		}
		statements.push(db.prepare(SET_HIGHLIGHT).bind(thread.id, flag));
	}

	// The saved comments, in the order sent.
	const saves = multiRowInserts(
		db,
		INSERT_COMMENTS_HEAD,
		SAVE_COMMENTS_TAIL,
		COMMENT_WIDTH,
		commentRows(thread.id, change.save),
	);
	statements.push(...saves);

	// The deleted comments, found through the primary key and limited to this thread, as many ids per statement as
	// the bound values allow after the thread's id.
	const perDelete = MAX_BOUND_VALUES - 1;
	for (let start = 0; start < change.delete.length; start += perDelete) {
		const ids = change.delete.slice(start, start + perDelete);
		const marks = new Array(ids.length).fill("?").join(", ");
		statements.push(
			db
				.prepare(
					`DELETE FROM comments WHERE thread_id = ? AND id IN (${marks})`,
				)
				.bind(thread.id, ...ids),
		);
	}
	statements.push(db.prepare(DELETE_EMPTY_THREAD).bind(thread.id));

	// Refuse before touching the database when the change is past the request's statement limit.
	if (statements.length > MAX_STATEMENTS) {
		throw new BodyProblem(
			`the change needs more than ${MAX_STATEMENTS} database statements`,
			413,
		);
	}
	await runBatch(db, statements, count);
}
