// The owner routes' reads: the whole site's state for the owner's page, and the notes of a few entries for the
// connector. Every statement's cost goes to `count`, as push does, for the request's log line.
import type {
	Comment,
	CommentAuthor,
	EntryNotes,
	FeedbackMark,
	OwnerState,
	ReadMark,
	SiteThread,
	Tags,
	Takeaway,
	TakeawaySource,
} from "../../../shared/owner-protocol.ts";
import { MAX_BOUND_VALUES, type QueryCost, runBatch } from "../d1.ts";

type Row = Record<string, unknown>;

// The takeaways columns, as takeawayOf reads a row.
const TAKEAWAY_COLUMNS =
	"id, entry_id, takeaway, recall_question, created, edited, source";

// A takeaways row as the protocol's Takeaway.
function takeawayOf(row: Row): Takeaway {
	return {
		id: String(row.id),
		text: String(row.takeaway),
		question: row.recall_question as string | null,
		created: String(row.created),
		edited: row.edited as string | null,
		source: row.source as TakeawaySource,
	};
}

// A read_state row as the entry's read mark.
function readMarkFromRow(row: Row): ReadMark {
	return {
		depth: row.depth as ReadMark["depth"],
		date: String(row.date),
	};
}

// A feedback row as the entry's Dislike, OK or Like.
function feedbackFromRow(row: Row): FeedbackMark {
	return {
		mark: row.mark as FeedbackMark["mark"],
		date: String(row.date),
	};
}

// A tags row's tags that are on, set on `tags`.
function addTagFromRow(tags: Tags, row: Row): void {
	if (row.to_read) {
		tags.toRead = true;
	}
	if (row.learn_first) {
		tags.learnFirst = true;
	}
}

// A threads row as a thread with no comments yet.
function threadFromRow(row: Row): SiteThread {
	return {
		id: String(row.id),
		field: row.field as SiteThread["field"],
		passage: row.passage as string | null,
		occurrence: row.occurrence as number | null,
		highlight: row.highlight === 1,
		comments: [],
	};
}

// A comments row as a comment; `idColumn` is the column that holds the comment's id (a join names it comment_id).
function commentFromRow(row: Row, idColumn: "id" | "comment_id"): Comment {
	return {
		id: String(row[idColumn]),
		text: String(row.text),
		created: String(row.created),
		edited: row.edited as string | null,
		author: row.author as CommentAuthor,
	};
}

// GET state: every read mark, tag, like or dislike, thread with its comments, takeaway (newest first) and marked
// paper, in the shapes of shared/owner-protocol.ts. Seven reads in one batch, so the answer is one moment's state. Threads and comments come back in the order they were
// stored (rowid): a thread's replies oldest first, as the page sent them.
export async function readState(
	db: D1Database,
	count: (cost: QueryCost) => void,
): Promise<OwnerState> {
	const answers = await runBatch(
		db,
		[
			db.prepare("SELECT entry_id, depth, date FROM read_state"),
			db.prepare("SELECT entry_id, to_read, learn_first FROM tags"),
			db.prepare(
				"SELECT id, entry_id, field, passage, occurrence, highlight FROM threads ORDER BY rowid",
			),
			db.prepare(
				"SELECT id, thread_id, text, created, edited, author FROM comments ORDER BY rowid",
			),
			db.prepare("SELECT entry_id, mark, date FROM feedback"),
			db.prepare(
				`SELECT ${TAKEAWAY_COLUMNS} FROM takeaways ORDER BY created DESC`,
			),
			db.prepare(
				"SELECT entry_id, date, note FROM standouts WHERE date IS NOT NULL",
			),
		],
		count,
	);
	const readRows = answers[0];
	const tagRows = answers[1];
	const threadRows = answers[2];
	const commentRowsRead = answers[3];
	const feedbackRows = answers[4];
	const takeawayRows = answers[5];
	const standoutRows = answers[6];
	if (
		readRows === undefined ||
		tagRows === undefined ||
		threadRows === undefined ||
		commentRowsRead === undefined ||
		feedbackRows === undefined ||
		takeawayRows === undefined ||
		standoutRows === undefined
	) {
		throw new Error("D1 answered fewer statements than it was given");
	}

	// Objects without a prototype, so an entry id like "__proto__" stays an ordinary key.
	const state: OwnerState = {
		read: Object.create(null),
		tags: Object.create(null),
		comments: Object.create(null),
		feedback: Object.create(null),
		takeaways: Object.create(null),
		standouts: Object.create(null),
	};
	for (const row of standoutRows.results) {
		state.standouts[String(row.entry_id)] = {
			date: String(row.date),
			note: String(row.note),
		};
	}
	for (const row of readRows.results) {
		state.read[String(row.entry_id)] = readMarkFromRow(row);
	}
	for (const row of takeawayRows.results) {
		const entryId = String(row.entry_id);
		let list = state.takeaways[entryId];
		if (list === undefined) {
			list = [];
			state.takeaways[entryId] = list;
		}
		list.push(takeawayOf(row));
	}
	for (const row of feedbackRows.results) {
		state.feedback[String(row.entry_id)] = feedbackFromRow(row);
	}
	for (const row of tagRows.results) {
		const tags: Tags = {};
		addTagFromRow(tags, row);
		state.tags[String(row.entry_id)] = tags;
	}
	// Threads by id, each added to its entry's list in stored order; then each comment to its thread.
	const threads = new Map<string, SiteThread>();
	for (const row of threadRows.results) {
		const thread = threadFromRow(row);
		threads.set(thread.id, thread);
		const entryId = String(row.entry_id);
		let list = state.comments[entryId];
		if (list === undefined) {
			list = [];
			state.comments[entryId] = list;
		}
		list.push(thread);
	}
	for (const row of commentRowsRead.results) {
		const thread = threads.get(String(row.thread_id));
		if (thread === undefined) {
			continue;
		}
		thread.comments.push(commentFromRow(row, "id"));
	}
	return state;
}

// What the owner made of each of `ids`, for the connector's search and get_digest: one batch through the tables' primary
// keys and the threads_entry and takeaways_entry indexes, at most MAX_BOUND_VALUES ids a statement, so it reads only
// these entries' rows. An entry with no mark, tag, like, thread or takeaway is left out of the map. Threads and their
// comments come in stored order, takeaways newest first.
export async function notesFor(
	db: D1Database,
	ids: string[],
	count: (cost: QueryCost) => void,
): Promise<Map<string, EntryNotes>> {
	const notes = new Map<string, EntryNotes>();
	if (ids.length === 0) {
		return notes;
	}
	// Five statements a chunk of ids: read marks, tags, likes and dislikes, threads with their comments, then takeaways
	// through takeaways_entry, newest first.
	const statements: D1PreparedStatement[] = [];
	for (let start = 0; start < ids.length; start += MAX_BOUND_VALUES) {
		const chunk = ids.slice(start, start + MAX_BOUND_VALUES);
		const marks = chunk.map(() => "?").join(", ");
		statements.push(
			db
				.prepare(
					`SELECT entry_id, depth, date FROM read_state WHERE entry_id IN (${marks})`,
				)
				.bind(...chunk),
			db
				.prepare(
					`SELECT entry_id, to_read, learn_first FROM tags WHERE entry_id IN (${marks})`,
				)
				.bind(...chunk),
			db
				.prepare(
					`SELECT entry_id, mark, date FROM feedback WHERE entry_id IN (${marks})`,
				)
				.bind(...chunk),
			db
				.prepare(
					"SELECT t.id, t.entry_id, t.field, t.passage, t.occurrence, t.highlight, " +
						"c.id AS comment_id, c.text, c.created, c.edited, c.author " +
						`FROM threads t LEFT JOIN comments c ON c.thread_id = t.id WHERE t.entry_id IN (${marks}) ` +
						"ORDER BY t.rowid, c.rowid",
				)
				.bind(...chunk),
			db
				.prepare(
					`SELECT ${TAKEAWAY_COLUMNS} FROM takeaways WHERE entry_id IN (${marks}) ORDER BY created DESC`,
				)
				.bind(...chunk),
		);
	}
	const answers = await runBatch(db, statements, count);

	// The notes of one entry, made empty the first time it is named.
	const noteOf = (id: string) => {
		let note = notes.get(id);
		if (note === undefined) {
			note = {
				read: null,
				tags: null,
				feedback: null,
				threads: [],
				takeaways: [],
			};
			notes.set(id, note);
		}
		return note;
	};
	const threads = new Map<string, SiteThread>();
	for (let k = 0; k < answers.length; k += 5) {
		const readRows = answers[k];
		const tagRows = answers[k + 1];
		const feedbackRows = answers[k + 2];
		const threadRows = answers[k + 3];
		const takeawayRows = answers[k + 4];
		if (
			readRows === undefined ||
			tagRows === undefined ||
			feedbackRows === undefined ||
			threadRows === undefined ||
			takeawayRows === undefined
		) {
			throw new Error("D1 answered fewer statements than it was given");
		}
		for (const row of takeawayRows.results) {
			noteOf(String(row.entry_id)).takeaways.push(takeawayOf(row));
		}
		for (const row of readRows.results) {
			noteOf(String(row.entry_id)).read = readMarkFromRow(row);
		}
		for (const row of tagRows.results) {
			const tags: Tags = {};
			addTagFromRow(tags, row);
			noteOf(String(row.entry_id)).tags = tags;
		}
		for (const row of feedbackRows.results) {
			noteOf(String(row.entry_id)).feedback = feedbackFromRow(row);
		}
		// One row per comment, or one with no comment for a highlight that holds none.
		for (const row of threadRows.results) {
			const id = String(row.id);
			let thread = threads.get(id);
			if (thread === undefined) {
				thread = threadFromRow(row);
				threads.set(id, thread);
				noteOf(String(row.entry_id)).threads.push(thread);
			}
			if (row.comment_id !== null) {
				thread.comments.push(commentFromRow(row, "comment_id"));
			}
		}
	}
	return notes;
}
