// What the owner routes accept in a body: each check returns the change the body holds, or throws a BodyProblem (400).
// Shapes and limits: shared/owner-protocol.ts.
import { isDay } from "../../../shared/entry-checks.ts";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import {
	type CommentsChange,
	type FeedbackChange,
	isDepth,
	MAX_ID_LENGTH,
	OWNER_TEXT_CHARS,
	type PageComment,
	type ReadChange,
	type StandoutChange,
	type TagsChange,
	type TakeawayChange,
	type ThreadPlace,
} from "../../../shared/owner-protocol.ts";
import { BodyProblem } from "../respond.ts";

// A comment's time as the page writes it, new Date().toISOString(): "2026-09-27T16:20:00.000Z".
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// An entry, thread or comment id: text of 1 to MAX_ID_LENGTH characters.
function isId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ID_LENGTH
	);
}

// A UTC time a browser can read back.
function isUtcTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		UTC_TIME.test(value) &&
		!Number.isNaN(Date.parse(value))
	);
}

// A JSON object's own field, or undefined: a field named like Object's own ("constructor") isn't read from the
// prototype.
function field(object: JsonObject, name: string): unknown {
	if (Object.hasOwn(object, name)) {
		return object[name];
	}
	return undefined;
}

// The body of POST read: {"id", "depth": a depth or null, "date": YYYY-MM-DD}.
export function readChangeOf(body: unknown): ReadChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const id = field(body, "id");
	const depth = field(body, "depth");
	const date = field(body, "date");
	if (!isId(id)) {
		throw new BodyProblem(
			`id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if (depth !== null && !isDepth(depth)) {
		throw new BodyProblem('depth must be "abstract", "paper", "read" or null');
	}
	if (!isDay(date)) {
		throw new BodyProblem("date must be YYYY-MM-DD");
	}
	return { id: id, depth: depth, date: date };
}

// The body of POST tags: {"id", "tag": "toRead" or "learnFirst", "on": true or false}.
export function tagsChangeOf(body: unknown): TagsChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const id = field(body, "id");
	const tag = field(body, "tag");
	const on = field(body, "on");
	if (!isId(id)) {
		throw new BodyProblem(
			`id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if (tag !== "toRead" && tag !== "learnFirst") {
		throw new BodyProblem('tag must be "toRead" or "learnFirst"');
	}
	if (typeof on !== "boolean") {
		throw new BodyProblem("on must be true or false");
	}
	return { id: id, tag: tag, on: on };
}

// The body of POST feedback: {"id", "mark": "dislike", "ok", "like" or null, "date": YYYY-MM-DD}.
export function feedbackChangeOf(body: unknown): FeedbackChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const id = field(body, "id");
	const mark = field(body, "mark");
	const date = field(body, "date");
	if (!isId(id)) {
		throw new BodyProblem(
			`id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if (mark !== "dislike" && mark !== "ok" && mark !== "like" && mark !== null) {
		throw new BodyProblem('mark must be "dislike", "ok", "like" or null');
	}
	if (!isDay(date)) {
		throw new BodyProblem("date must be YYYY-MM-DD");
	}
	return { id: id, mark: mark, date: date };
}

// The body of POST standouts.
export function standoutChangeOf(body: unknown): StandoutChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const id = field(body, "id");
	const marked = field(body, "marked");
	const note = field(body, "note");
	if (!isId(id)) {
		throw new BodyProblem(
			`id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if ((marked === undefined) === (note === undefined)) {
		throw new BodyProblem("a standout change holds a mark or a note");
	}
	if (note !== undefined) {
		if (typeof note !== "string") {
			throw new BodyProblem("note must be text");
		}
		if (note.length > OWNER_TEXT_CHARS) {
			throw new BodyProblem(
				`a note is too long: at most ${OWNER_TEXT_CHARS} characters`,
			);
		}
		return { id: id, note: note };
	}
	const date = field(body, "date");
	if (typeof marked !== "boolean") {
		throw new BodyProblem("marked must be true or false");
	}
	if (!isDay(date)) {
		throw new BodyProblem("date must be YYYY-MM-DD");
	}
	return { id: id, marked: marked, date: date };
}

// The body of POST takeaways: {"entryId", "save": {"id", "text", "question", "created", "edited"}} or {"entryId",
// "delete": a takeaway id}, never both. The text can't be empty or only spaces, and neither it nor the question may
// be longer than OWNER_TEXT_CHARS; an empty question is null. The source is the site's to set, so a save that names
// one is refused.
export function takeawayChangeOf(body: unknown): TakeawayChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const entryId = field(body, "entryId");
	const save = field(body, "save");
	const remove = field(body, "delete");
	if (!isId(entryId)) {
		throw new BodyProblem(
			`entryId must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if ((save === undefined) === (remove === undefined)) {
		throw new BodyProblem("a takeaway change holds a save or a delete");
	}
	if (remove !== undefined) {
		if (!isId(remove)) {
			throw new BodyProblem("delete must be a takeaway id");
		}
		return { entryId: entryId, delete: remove };
	}
	if (!isJsonObject(save)) {
		throw new BodyProblem("save must be a takeaway");
	}
	const id = field(save, "id");
	const text = field(save, "text");
	const question = field(save, "question");
	const created = field(save, "created");
	const edited = field(save, "edited");
	if (!isId(id)) {
		throw new BodyProblem(
			`a takeaway id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if (typeof text !== "string" || text.trim() === "") {
		throw new BodyProblem("a takeaway's text can't be empty");
	}
	if (text.length > OWNER_TEXT_CHARS) {
		throw new BodyProblem(
			`a takeaway's text is too long: at most ${OWNER_TEXT_CHARS} characters`,
		);
	}
	if (
		question !== null &&
		question !== undefined &&
		typeof question !== "string"
	) {
		throw new BodyProblem("a takeaway's question must be text or null");
	}
	if (typeof question === "string" && question.length > OWNER_TEXT_CHARS) {
		throw new BodyProblem(
			`a takeaway's question is too long: at most ${OWNER_TEXT_CHARS} characters`,
		);
	}
	if (!isUtcTime(created)) {
		throw new BodyProblem("a takeaway's created must be a UTC time");
	}
	if (edited !== null && edited !== undefined && !isUtcTime(edited)) {
		throw new BodyProblem("a takeaway's edited must be a UTC time or null");
	}
	if (field(save, "source") !== undefined) {
		throw new BodyProblem("a takeaway's source is the site's to set");
	}
	let kept: string | null = null;
	if (typeof question === "string" && question.trim() !== "") {
		kept = question;
	}
	let editedTime: string | null = null;
	if (typeof edited === "string") {
		editedTime = edited;
	}
	return {
		entryId: entryId,
		save: {
			id: id,
			text: text,
			question: kept,
			created: created,
			edited: editedTime,
		},
	};
}

// One comment: {"id", "text" of at most OWNER_TEXT_CHARS, "created": a UTC time, "edited": a UTC time or null}. It
// names no author: this route stores the owner's comments, so a body that names one, even "owner", is refused.
function commentOf(value: unknown): PageComment {
	if (!isJsonObject(value)) {
		throw new BodyProblem("a comment is not an object");
	}
	if (Object.hasOwn(value, "author")) {
		throw new BodyProblem(
			"a comment can't name its author: this route saves the owner's comments",
		);
	}
	const id = field(value, "id");
	const text = field(value, "text");
	const created = field(value, "created");
	const edited = field(value, "edited");
	if (!isId(id)) {
		throw new BodyProblem(
			`a comment id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	if (typeof text !== "string") {
		throw new BodyProblem("a comment's text must be text");
	}
	if (text.length > OWNER_TEXT_CHARS) {
		throw new BodyProblem(
			`a comment's text is too long: at most ${OWNER_TEXT_CHARS} characters`,
		);
	}
	if (!isUtcTime(created)) {
		throw new BodyProblem("a comment's created must be a UTC time");
	}
	if (edited !== null && edited !== undefined && !isUtcTime(edited)) {
		throw new BodyProblem("a comment's edited must be a UTC time or null");
	}
	let editedTime: string | null = null;
	if (typeof edited === "string") {
		editedTime = edited;
	}
	return { id: id, text: text, created: created, edited: editedTime };
}

// A thread's id and place. A thread on a passage names its field, the passage and which occurrence (from 1); a thread
// on the whole entry has field null, and the page may have left its anchor fields out, which reads as null.
function threadPlaceOf(value: unknown): ThreadPlace {
	if (!isJsonObject(value)) {
		throw new BodyProblem("a thread is not an object");
	}
	const id = field(value, "id");
	const threadField = field(value, "field");
	const passage = field(value, "passage");
	const occurrence = field(value, "occurrence");
	if (!isId(id)) {
		throw new BodyProblem(
			`a thread id must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	const thread: ThreadPlace = {
		id: id,
		field: null,
		passage: null,
		occurrence: null,
	};
	if (threadField === "title" || threadField === "abstract") {
		if (typeof passage !== "string" || passage === "") {
			throw new BodyProblem("a thread on a passage must name the passage");
		}
		if (
			typeof occurrence !== "number" ||
			!Number.isInteger(occurrence) ||
			occurrence < 1
		) {
			throw new BodyProblem(
				"a thread's occurrence must be a whole number from 1",
			);
		}
		thread.field = threadField;
		thread.passage = passage;
		thread.occurrence = occurrence;
	} else if (threadField === null || threadField === undefined) {
		// A whole-entry thread keeps a passage or occurrence it was saved with, as the page kept them.
		if (typeof passage === "string") {
			thread.passage = passage;
		} else if (passage !== null && passage !== undefined) {
			throw new BodyProblem("a thread's passage must be text or null");
		}
		if (typeof occurrence === "number" && Number.isInteger(occurrence)) {
			thread.occurrence = occurrence;
		} else if (occurrence !== null && occurrence !== undefined) {
			throw new BodyProblem(
				"a thread's occurrence must be a whole number or null",
			);
		}
	} else {
		throw new BodyProblem(
			'a thread\'s field must be "title", "abstract" or null',
		);
	}
	return thread;
}

// The body of POST comments: {"entryId", "thread": its id and place, "save": comments, "delete": comment ids, and
// optionally "highlight": true or false}, saving or deleting at least one comment unless it holds "highlight". Only a
// thread on a passage can be a highlight.
export function commentsChangeOf(body: unknown): CommentsChange {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const entryId = field(body, "entryId");
	const save = field(body, "save");
	const remove = field(body, "delete");
	const highlight = field(body, "highlight");
	if (!isId(entryId)) {
		throw new BodyProblem(
			`entryId must be text of at most ${MAX_ID_LENGTH} characters`,
		);
	}
	const thread = threadPlaceOf(field(body, "thread"));
	if (!Array.isArray(save) || !Array.isArray(remove)) {
		throw new BodyProblem("save and delete must be lists");
	}
	if (highlight !== undefined && typeof highlight !== "boolean") {
		throw new BodyProblem("highlight must be true or false");
	}
	if (highlight !== undefined && thread.field === null) {
		throw new BodyProblem("only a passage can be highlighted");
	}
	if (save.length === 0 && remove.length === 0 && highlight === undefined) {
		throw new BodyProblem("save or delete must hold a comment");
	}
	const change: CommentsChange = {
		entryId: entryId,
		thread: thread,
		save: [],
		delete: [],
	};
	if (typeof highlight === "boolean") {
		change.highlight = highlight;
	}
	for (const comment of save) {
		change.save.push(commentOf(comment));
	}
	for (const id of remove) {
		if (!isId(id)) {
			throw new BodyProblem("delete must hold comment ids");
		}
		change.delete.push(id);
	}
	return change;
}
