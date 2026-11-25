// What the owner routes accept in a body and what they refuse with a 400, run against the Worker's own checks.
import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import {
	MAX_ID_LENGTH,
	OWNER_TEXT_CHARS,
} from "../../shared/owner-protocol.ts";
import { type BodyProblem, workerModule } from "./owner-worker.ts";

type Checks = Record<string, (body: unknown) => unknown>;
type Respond = { BodyProblem: new (message: string) => BodyProblem };

let checks: Checks;
let respond: Respond;

beforeAll(async () => {
	checks = await workerModule<Checks>("owner/checks.ts");
	respond = await workerModule<Respond>("respond.ts");
});

const CREATED = "2026-11-05T01:00:00.000Z";

// A body each check takes, as the page posts it.
const WELL_FORMED: Record<string, unknown> = {
	readChangeOf: { id: "arxiv:2601.00001", depth: "paper", date: "2026-11-05" },
	tagsChangeOf: { id: "arxiv:2601.00001", tag: "toRead", on: true },
	feedbackChangeOf: {
		id: "arxiv:2601.00001",
		mark: "like",
		date: "2026-11-05",
	},
	standoutChangeOf: {
		id: "arxiv:2601.00001",
		marked: true,
		date: "2026-11-05",
	},
	takeawayChangeOf: {
		entryId: "arxiv:2601.00001",
		save: { id: "k1", text: "a takeaway", question: null, created: CREATED },
	},
	commentsChangeOf: {
		entryId: "arxiv:2601.00001",
		thread: { id: "t1", field: null, passage: null, occurrence: null },
		save: [{ id: "c1", text: "a comment", created: CREATED, edited: null }],
		delete: [],
	},
};

// The refusal a check throws for `body`, or a failure when it takes the body.
function refusalOf(name: string, body: unknown): BodyProblem {
	const check = checks[name];
	assert.ok(check, `${name} is exported`);
	try {
		check(body);
	} catch (error) {
		assert.ok(
			error instanceof respond.BodyProblem,
			`a refusal, not ${String(error)}`,
		);
		return error;
	}
	throw new Error(`${name} took the body`);
}

for (const name of Object.keys(WELL_FORMED)) {
	test(`${name} accepts a change in the shape the page posts`, () => {
		const check = checks[name];
		assert.ok(check, `${name} is exported`);
		assert.doesNotThrow(() => check(WELL_FORMED[name]));
	});

	test(`${name} refuses a body that is not an object with 400`, () => {
		for (const body of [null, "text", 7, ["a"]]) {
			const problem = refusalOf(name, body);
			assert.equal(problem.status, 400);
			assert.equal(problem.message, "body is not an object");
		}
	});
}

test("security: an entry id of 2,000 characters is taken and one of 2,001 is refused with a message that names the limit", () => {
	const longest = "x".repeat(MAX_ID_LENGTH);
	const tooLong = "x".repeat(MAX_ID_LENGTH + 1);
	assert.doesNotThrow(() =>
		checks.readChangeOf?.({
			...(WELL_FORMED.readChangeOf as object),
			id: longest,
		}),
	);
	const problem = refusalOf("readChangeOf", {
		...(WELL_FORMED.readChangeOf as object),
		id: tooLong,
	});
	assert.equal(problem.status, 400);
	assert.ok(problem.message.includes(String(MAX_ID_LENGTH)), problem.message);
});

// A well-formed body of `name` with some of its fields changed.
function withChange(name: string, change: Record<string, unknown>): unknown {
	return { ...(WELL_FORMED[name] as object), ...change };
}

test("a read mark's depth is abstract, paper, read or null, and its date is a real day", () => {
	for (const depth of ["abstract", "paper", "read", null]) {
		assert.doesNotThrow(() =>
			checks.readChangeOf?.(withChange("readChangeOf", { depth: depth })),
		);
	}
	for (const depth of ["skim", "", 1, undefined]) {
		const problem = refusalOf(
			"readChangeOf",
			withChange("readChangeOf", { depth: depth }),
		);
		assert.equal(problem.status, 400);
	}
	for (const date of [
		"2026-02-30",
		"5 Nov 2026",
		"2026-11-5",
		null,
		20261105,
	]) {
		const problem = refusalOf(
			"readChangeOf",
			withChange("readChangeOf", { date: date }),
		);
		assert.equal(problem.message, "date must be YYYY-MM-DD");
	}
});

test("a tag is toRead or learnFirst, and its on field is true or false", () => {
	for (const body of [
		withChange("tagsChangeOf", { tag: "done" }),
		withChange("tagsChangeOf", { on: "yes" }),
		withChange("tagsChangeOf", { on: undefined }),
	]) {
		assert.equal(refusalOf("tagsChangeOf", body).status, 400);
	}
	assert.doesNotThrow(() =>
		checks.tagsChangeOf?.(
			withChange("tagsChangeOf", { tag: "learnFirst", on: false }),
		),
	);
});

test("a feedback mark is dislike, ok, like or null", () => {
	for (const mark of ["dislike", "ok", "like", null]) {
		assert.doesNotThrow(() =>
			checks.feedbackChangeOf?.(withChange("feedbackChangeOf", { mark: mark })),
		);
	}
	assert.equal(
		refusalOf(
			"feedbackChangeOf",
			withChange("feedbackChangeOf", { mark: "love" }),
		).status,
		400,
	);
});

test("a standout change holds a mark or a note, a mark's marked is true or false, and its date is a real day", () => {
	assert.doesNotThrow(() =>
		checks.standoutChangeOf?.({ id: "arxiv:2601.00001", note: "A note" }),
	);
	assert.doesNotThrow(() =>
		checks.standoutChangeOf?.(
			withChange("standoutChangeOf", { marked: false }),
		),
	);
	const bodies: Record<string, unknown> = {
		"a mark and a note": withChange("standoutChangeOf", { note: "A note" }),
		"neither a mark nor a note": { id: "arxiv:2601.00001" },
		"a marked that is not true or false": withChange("standoutChangeOf", {
			marked: "yes",
		}),
		"a note that is not text": { id: "arxiv:2601.00001", note: 7 },
		"a date that is not a real day": withChange("standoutChangeOf", {
			date: "2026-02-30",
		}),
		"no date with a mark": { id: "arxiv:2601.00001", marked: true },
	};
	for (const [name, body] of Object.entries(bodies)) {
		assert.equal(refusalOf("standoutChangeOf", body).status, 400, name);
	}
});

// A comment of `length` characters in a comments change.
function commentOfLength(length: number): unknown {
	return withChange("commentsChangeOf", {
		save: [
			{ id: "c1", text: "x".repeat(length), created: CREATED, edited: null },
		],
	});
}

test("security: a comment of 10,000 characters is taken and one of 10,001 is refused, naming the text as too long", () => {
	assert.doesNotThrow(() =>
		checks.commentsChangeOf?.(commentOfLength(OWNER_TEXT_CHARS)),
	);
	const problem = refusalOf(
		"commentsChangeOf",
		commentOfLength(OWNER_TEXT_CHARS + 1),
	);
	assert.equal(problem.status, 400);
	assert.match(problem.message, /text is too long/);
});

// A takeaway change saving `save` over the well-formed one.
function takeawayWith(save: Record<string, unknown>): unknown {
	const saved = (WELL_FORMED.takeawayChangeOf as { save: object }).save;
	return withChange("takeawayChangeOf", { save: { ...saved, ...save } });
}

test("security: a takeaway or recall question of 10,000 characters is taken and one of 10,001 is refused, naming which is too long", () => {
	assert.doesNotThrow(() =>
		checks.takeawayChangeOf?.(
			takeawayWith({ text: "x".repeat(OWNER_TEXT_CHARS) }),
		),
	);
	assert.doesNotThrow(() =>
		checks.takeawayChangeOf?.(
			takeawayWith({ question: "x".repeat(OWNER_TEXT_CHARS) }),
		),
	);
	const text = refusalOf(
		"takeawayChangeOf",
		takeawayWith({ text: "x".repeat(OWNER_TEXT_CHARS + 1) }),
	);
	assert.match(text.message, /text is too long/);
	const question = refusalOf(
		"takeawayChangeOf",
		takeawayWith({ question: "x".repeat(OWNER_TEXT_CHARS + 1) }),
	);
	assert.match(question.message, /question is too long/);
});

test("security: a takeaway with blank text, or with a source field that only the site sets, is refused", () => {
	for (const text of ["", "   ", undefined]) {
		assert.equal(
			refusalOf("takeawayChangeOf", takeawayWith({ text: text })).status,
			400,
		);
	}
	const sourced = refusalOf(
		"takeawayChangeOf",
		takeawayWith({ source: "claude.ai" }),
	);
	assert.match(sourced.message, /source is the site's to set/);
});

test("a takeaway change holds a save or a delete, never both and never neither", () => {
	const save = (WELL_FORMED.takeawayChangeOf as { save: object }).save;
	for (const body of [
		{ entryId: "arxiv:2601.00001" },
		{ entryId: "arxiv:2601.00001", save: save, delete: "k1" },
	]) {
		assert.equal(refusalOf("takeawayChangeOf", body).status, 400);
	}
	assert.doesNotThrow(() =>
		checks.takeawayChangeOf?.({ entryId: "arxiv:2601.00001", delete: "k1" }),
	);
});

test("a comment whose created time isn't a UTC time the browser can read is refused", () => {
	for (const created of [
		"yesterday",
		"2026-11-05",
		"2026-11-05T01:00:00+07:00",
		"2026-13-45T01:00:00Z",
	]) {
		const body = withChange("commentsChangeOf", {
			save: [{ id: "c1", text: "a comment", created: created, edited: null }],
		});
		assert.equal(refusalOf("commentsChangeOf", body).status, 400, created);
	}
});
