// Unit tests for the pure exports of scripts/deploy/sync.ts (changedEntries, requestsOf), on small hand-written digest lines.
// Checks of push: which entries push sends, where each sits in the file, and how they are
// split into requests.

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type * as SiteRequests from "../../scripts/deploy/site-requests.ts";
import type * as Sync from "../../scripts/deploy/sync.ts";
import type { JsonObject } from "../../shared/narrow.ts";
import { MAX_BODY_BYTES, MAX_ENTRIES } from "../../shared/push-protocol.ts";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/deploy/sync.ts", import.meta.url);
const SITE_REQUESTS = new URL(
	"../../scripts/deploy/site-requests.ts",
	import.meta.url,
);

// The script reads its retry second when it loads, after this top level has run: 1 ms instead of 1 s.
process.env.SYNC_RETRY_SECOND_MS = "1";
afterEach(closeServers);

// ---- Fixtures ----

// A paper as scripts/scout/arxiv/arxiv.ts writes it; n picks its id. `abstractLength` pads its abstract to that many characters.
function paper(n: number, abstractLength?: number): JsonObject {
	const arxivId = `2610.${String(n).padStart(5, "0")}`;
	let abstract = "We report what we measured.";
	if (abstractLength !== undefined) {
		abstract = abstract.padEnd(abstractLength, " Measured again.");
	}
	return {
		id: `arxiv:${arxivId}`,
		type: "paper",
		title: `Test paper ${n}`,
		authors: ["Yann LeCun", "Geoffrey Hinton"],
		published: "2026-10-01",
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${arxivId}`,
		links: [{ label: "PDF", url: `https://arxiv.org/pdf/${arxivId}` }],
		abstract: abstract,
	};
}

// One digest line as the scripts write it, ending in a line break.
function digestLine(date: string, entries: unknown[]) {
	return `digest(${JSON.stringify({ date: date, entries: entries })});\n`;
}

// Where push found each entry, as "<id> line <n> position <p> <date>", so a failure shows all of it at once.
function places(outgoing: Sync.Outgoing[]): string[] {
	return outgoing.map(
		(each) =>
			`${String(each.item.entry.id)} line ${each.line} position ${each.position} ${each.item.date}`,
	);
}

// What push would send for these entries: an outgoing item for each, all on line 1.
function outgoingOf(entries: JsonObject[]): Sync.Outgoing[] {
	return entries.map((entry, k) => ({
		item: { date: "2026-10-16", entry: entry },
		line: 1,
		position: k + 1,
	}));
}

// The size of a request's body as push sends it: {"entries": [...]} in UTF-8.
function bodyBytes(request: Sync.Outgoing[]): number {
	const body = JSON.stringify({ entries: request.map((each) => each.item) });
	return Buffer.byteLength(body, "utf8");
}

// ---- changedEntries ----

test("Without a pulled copy, push sends every entry in file order with its line, position and date", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const text =
		digestLine("2026-10-14", [paper(1), paper(2), paper(3)]) +
		digestLine("2026-10-16", [paper(4), paper(5)]);
	assert.deepEqual(places(changedEntries(text, null)), [
		"arxiv:2610.00001 line 1 position 1 2026-10-14",
		"arxiv:2610.00002 line 1 position 2 2026-10-14",
		"arxiv:2610.00003 line 1 position 3 2026-10-14",
		"arxiv:2610.00004 line 2 position 1 2026-10-16",
		"arxiv:2610.00005 line 2 position 2 2026-10-16",
	]);
});

test("Without a pulled copy, push sends each entry exactly as the file holds it", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const text = digestLine("2026-10-16", [paper(1)]);
	const outgoing = changedEntries(text, null);
	assert.deepEqual(
		outgoing.map((each) => each.item),
		[{ date: "2026-10-16", entry: paper(1) }],
	);
});

test("After a pull, push sends only new entries and entries that gained a field, in file order", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const pulled =
		digestLine("2026-10-13", [paper(1), paper(2)]) +
		digestLine("2026-10-14", [paper(3)]);
	const withFigure = Object.assign(paper(2), {
		figure: {
			src: "https://arxiv.org/html/2610.00002v1/x1.png",
			caption: "Figure 1",
			from: "https://arxiv.org/html/2610.00002v1",
		},
	});
	const text =
		digestLine("2026-10-13", [paper(1), withFigure]) +
		digestLine("2026-10-14", [paper(3)]) +
		digestLine("2026-10-16", [paper(4)]);
	assert.deepEqual(places(changedEntries(text, pulled)), [
		"arxiv:2610.00002 line 1 position 2 2026-10-13",
		"arxiv:2610.00004 line 3 position 1 2026-10-16",
	]);
});

test("A file equal to its pulled copy has nothing to push", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const text = digestLine("2026-10-16", [paper(1), paper(2)]);
	assert.deepEqual(changedEntries(text, text), []);
});

test("Push sends nothing for an entry removed from the file since the pull, so it stays on the site", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const pulled = digestLine("2026-10-14", [paper(1), paper(2)]);
	const text = digestLine("2026-10-14", [paper(2)]);
	assert.deepEqual(changedEntries(text, pulled), []);
});

test("An id on two lines is pushed twice, in file order", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const withFigure = Object.assign(paper(1), {
		figure: {
			src: "https://arxiv.org/html/2610.00001v1/x1.png",
			caption: "Figure 1",
			from: "https://arxiv.org/html/2610.00001v1",
		},
	});
	const text =
		digestLine("2026-10-15", [paper(1)]) +
		digestLine("2026-10-16", [withFigure]);
	assert.deepEqual(places(changedEntries(text, null)), [
		"arxiv:2610.00001 line 1 position 1 2026-10-15",
		"arxiv:2610.00001 line 2 position 1 2026-10-16",
	]);
});

test("A line that does not load stops the push with an error naming the line", async () => {
	const { changedEntries }: typeof Sync = await import(SCRIPT.href);
	const text = `${digestLine("2026-10-16", [paper(1)])}this line is not a digest line\n`;
	assert.throws(
		() => changedEntries(text, null),
		(error: unknown) =>
			error instanceof Error && error.message.startsWith("line 2 doesn't load"),
	);
});

// ---- requestsOf ----

// Small entries, so only the entry limit cuts them: two full requests and the rest.
test("Many small entries are split into requests of at most the entry limit, in order", async () => {
	const { requestsOf }: typeof Sync = await import(SCRIPT.href);
	const entries: JsonObject[] = [];
	for (let n = 1; n <= MAX_ENTRIES * 2 + 1; n++) {
		entries.push(paper(n));
	}
	const outgoing = outgoingOf(entries);
	const requests = requestsOf(outgoing);
	assert.deepEqual(
		requests.map((request) => request.length),
		[MAX_ENTRIES, MAX_ENTRIES, 1],
	);
	assert.deepEqual(requests.flat(), outgoing);
});

// MAX_ENTRIES entries of 50,000 characters are over MAX_BODY_BYTES together, so the size has to cut them.
test("Entries of 50,000 characters are split into requests under the body size limit, each sent once, in order", async () => {
	const { requestsOf }: typeof Sync = await import(SCRIPT.href);
	const entries: JsonObject[] = [];
	for (let n = 1; n <= MAX_ENTRIES; n++) {
		entries.push(paper(n, 50000));
	}
	const outgoing = outgoingOf(entries);
	assert.ok(
		bodyBytes(outgoing) > MAX_BODY_BYTES,
		"the entries together are over the byte limit",
	);
	const requests = requestsOf(outgoing);
	assert.ok(requests.length > 1, "more than one request");
	for (const request of requests) {
		assert.ok(request.length > 0, "no empty request");
		assert.ok(
			request.length <= MAX_ENTRIES,
			`at most ${MAX_ENTRIES} entries, got ${request.length}`,
		);
		assert.ok(
			bodyBytes(request) <= MAX_BODY_BYTES,
			`a body of at most ${MAX_BODY_BYTES} bytes, got ${bodyBytes(request)}`,
		);
	}
	assert.deepEqual(requests.flat(), outgoing);
});

// ---- requestWithRetry ----

// A request to a local server that answers 200 is returned as its text, and each try is given 60 seconds.
test("limit: A request is given 60 seconds to be answered", async () => {
	const { requestWithRetry }: typeof SiteRequests = await import(
		SITE_REQUESTS.href
	);
	const base = await serve((_in, out) => out.end("the answer"));
	const limits = vi.spyOn(AbortSignal, "timeout");
	try {
		const text = await requestWithRetry(
			`${base}/x`,
			{ method: "GET", headers: {}, body: null },
			"pull",
			"the site",
		);
		assert.equal(text, "the answer");
		assert.deepEqual(limits.mock.calls, [[60_000]]);
	} finally {
		limits.mockRestore();
	}
});

// A redirect is an answer other than 2xx: it is tried again, never followed to the address it names.
test("security: A redirect is never followed and counts as a failed try, so the request fails after six tries", async () => {
	const { requestWithRetry }: typeof SiteRequests = await import(
		SITE_REQUESTS.href
	);
	const asked: string[] = [];
	const base = await serve((incoming, out) => {
		asked.push(String(incoming.url));
		out.writeHead(302, { location: "/target" });
		out.end();
	});
	const told = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await assert.rejects(
			requestWithRetry(
				`${base}/start`,
				{ method: "GET", headers: {}, body: null },
				"pull",
				"the site",
			),
			{ message: "pull failed: the site answered 302 six times" },
		);
		assert.deepEqual(asked, Array(6).fill("/start"));
	} finally {
		told.mockRestore();
	}
});

test.todo("pull writes the marked papers and their notes for the build");
test.todo("privacy: pull never writes an unmarked paper's note for the build");
