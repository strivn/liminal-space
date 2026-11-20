// The connector's five tools, each handler beside its description and input schema. mcp.ts lists them to the model and runs
// the one a call names.
// search and get_digest read the entries and the owner's notes from D1, so an entry is found as soon as it is pushed.
// An add tool call only queues an add request and asks GitHub to run add.yml; add.yml appends with the scout's scripts.
// The tools' descriptions tell the model what scripts/scout/scout.md's "Adding news, articles and reports" says: fetch the page and
// copy title, source and date from it, never from memory.
import { isArxivId, normalizeId } from "../../shared/arxiv-id.ts";
import {
	type AddKind,
	type AddPayload,
	MAX_LINKS_PER_CALL,
	MAX_PAPERS_PER_CALL,
} from "../../shared/connector-protocol.ts";
import {
	entryProblems,
	isDay,
	linkLabel,
	normalizeUrl,
} from "../../shared/entry-checks.ts";
import { digestMarkdown, entryMarkdown } from "../../shared/entry-markdown.ts";
import { isLocalHost } from "../../shared/local-address.ts";
import { isJsonObject, type JsonObject } from "../../shared/narrow.ts";
import { OWNER_TEXT_CHARS } from "../../shared/owner-protocol.ts";
import { countOne, type QueryCost, runBatch } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import { notesFor } from "./owner/notes.ts";
import { proposeTakeaway as saveProposedTakeaway } from "./owner/store.ts";
import { enqueue, QueueFull } from "./requests.ts";
import { dispatchWorkflow } from "./schedule.ts";

// A tool's answer: its text, and whether it refused (MCP's isError, which the model reads and can correct).
export type ToolAnswer = { text: string; isError: boolean };

// What a tool runs with: the Worker's bindings, the request's log line and its D1 cost counter.
export type ToolContext = {
	env: Env;
	log: RequestLog;
	count: (cost: QueryCost) => void;
};

// One tool: what tools/list tells the model, and the handler tools/call runs.
export type Tool = {
	name: string;
	description: string;
	inputSchema: JsonObject;
	run: (args: JsonObject, context: ToolContext) => Promise<ToolAnswer>;
};

// A tool's arguments the Worker can't use at all: the call answers a JSON-RPC error -32602 with this message.
export class BadParams extends Error {}

// Fields of a link only add.yml writes: describe.ts copies the publisher's description there, or writes an
// "[AI Summarized] " summary that says so (a description from the chat would show unlabelled), and digests.ts add
// --ad-hoc sets "ad_hoc".
const ADD_RUN_FIELDS = ["description", "ad_hoc"];

// search's limits on its query, checked before any query runs.
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_WORDS = 10;
// D1's limit on a LIKE pattern's length (https://developers.cloudflare.com/d1/platform/limits/); local SQLite has none.
const MAX_LIKE_PATTERN_BYTES = 50;
// The entry fields search matches a word in, besides the owner's comments.
const SEARCH_FIELDS = [
	"title",
	"authors",
	"abstract",
	"description",
	"source",
	"venue",
];
// search shows this many matches, and cuts each abstract and description to this many characters.
const SEARCH_SHOWN = 20;
const SEARCH_CUT = 300;
// get_digest's answer stops after the last whole entry under this size (one month whole is about 180k tokens).
const MAX_DIGEST_BYTES = 60 * 1024;

// One row of the entries table as search and get_digest read it.
type EntryRow = { id: string; date: string; json: string };

// The apps a chat can save a takeaway from; the page is the third source (shared/owner-protocol.ts).
const TAKEAWAY_APPS = ["claude.ai", "ChatGPT"];

// "1 paper", "2 papers"; "1 link", "2 links".
function counted(count: number, kind: AddKind) {
	let noun = "paper";
	if (kind === "links") {
		noun = "link";
	}
	if (count === 1) {
		return `1 ${noun}`;
	}
	return `${count} ${noun}s`;
}

// How many ids or links a payload holds.
function payloadSize(payload: AddPayload) {
	if ("papers" in payload) {
		return payload.papers.length;
	}
	return payload.links.length;
}

// Queue a checked payload and start add.yml: the answer says it is queued and when to check the page.
async function queueAndStart(
	context: ToolContext,
	kind: AddKind,
	payload: AddPayload,
): Promise<ToolAnswer> {
	const { env, log, count } = context;
	try {
		await enqueue(env.DB, kind, payload, count);
	} catch (error) {
		if (error instanceof QueueFull) {
			return {
				text: `${error.message}; try again in a few minutes.`,
				isError: true,
			};
		}
		throw error;
	}
	const head = `Queued ${counted(payloadSize(payload), kind)}.`;

	// The request waits in the queue either way; the 15-minute cron starts add.yml again when this dispatch failed.
	const dispatch = await dispatchWorkflow(env, "add.yml", "add.yml");
	if (dispatch.reason !== undefined) {
		log.reason = dispatch.reason;
		return {
			text: `${head} The add run couldn't start yet; it will be retried within 15 minutes. Tell the user to check the page in about 20 minutes.`,
			isError: false,
		};
	}
	return {
		text: `${head} Tell the user to check the page in a few minutes.`,
		isError: false,
	};
}

// The arguments' ids as given, a list of text. Throws BadParams when ids isn't one.
function idsOf(args: JsonObject): string[] {
	const ids = args.ids;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
		throw new BadParams("ids must be a list of arXiv ids");
	}
	return ids;
}

// add_papers: arXiv ids, at most MAX_PAPERS_PER_CALL as given, each "2507.11473" or "arxiv:2507.11473" (the prefix in
// any case), read as arxiv.ts reads them (shared/arxiv-id.ts). Each is queued once, as first given.
async function addPapers(
	args: JsonObject,
	context: ToolContext,
): Promise<ToolAnswer> {
	const given = idsOf(args);
	if (given.length === 0) {
		return { text: "Give at least one arXiv id.", isError: true };
	}
	if (given.length > MAX_PAPERS_PER_CALL) {
		return {
			text: `There are more than ${MAX_PAPERS_PER_CALL} ids in one call; send at most ${MAX_PAPERS_PER_CALL} at a time.`,
			isError: true,
		};
	}
	const ids = Array.from(new Set(given));
	const bad: string[] = [];
	for (const id of ids) {
		if (!isArxivId(normalizeId(id))) {
			bad.push(JSON.stringify(id));
		}
	}
	if (bad.length > 0) {
		return {
			text:
				`Not an arXiv id: ${bad.join(", ")}. Give ids such as 2507.11473 or arxiv:2507.11473, not links. ` +
				"Nothing was queued.",
			isError: true,
		};
	}
	return queueAndStart(context, "papers", { papers: ids });
}

const addPapersTool: Tool = {
	name: "add_papers",
	description:
		"Add arXiv papers to the user's Liminal space digests. Give arXiv ids such as 2507.11473 or arxiv:2507.11473, " +
		"never a link: for arxiv.org/abs/2507.11473 give 2507.11473. At most 10 ids a call. Give only the ids: the " +
		"add run copies title, authors and abstract from arXiv itself. The tool queues the request; the papers are on " +
		"the page a few minutes later.",
	inputSchema: {
		type: "object",
		properties: {
			ids: {
				type: "array",
				items: { type: "string" },
				minItems: 1,
				maxItems: MAX_PAPERS_PER_CALL,
				description: 'arXiv ids, "2507.11473" or "arxiv:2507.11473"',
			},
		},
		required: ["ids"],
		additionalProperties: false,
	},
	run: addPapers,
};

// What a link holds that the chat may not set: a field only add.yml writes, or a url whose host names this machine or
// a private network as written (add.yml's describe.ts fetches the url). Checked before entryProblems.
function chatProblems(item: unknown): string[] {
	if (!isJsonObject(item)) {
		return [];
	}
	const problems: string[] = [];
	for (const field of ADD_RUN_FIELDS) {
		if (item[field] !== undefined) {
			problems.push(`"${field}" is the add run's to set, not the chat's`);
		}
	}
	if (typeof item.url === "string") {
		const parsed = URL.parse(item.url);
		if (parsed !== null && isLocalHost(parsed.hostname)) {
			problems.push(
				`the url's address ${parsed.hostname} is local, not on the public internet`,
			);
		}
	}
	return problems;
}

// add_links: at most MAX_LINKS_PER_CALL news, articles and reports, each checked as digests.ts add checks it.
async function addLinks(
	args: JsonObject,
	context: ToolContext,
): Promise<ToolAnswer> {
	const links = args.links;
	if (!Array.isArray(links)) {
		throw new BadParams("links must be a list of links");
	}
	if (links.length === 0) {
		return { text: "Give at least one link.", isError: true };
	}
	if (links.length > MAX_LINKS_PER_CALL) {
		return {
			text: `There are more than ${MAX_LINKS_PER_CALL} links in this call: at most ${MAX_LINKS_PER_CALL} links a call.`,
			isError: true,
		};
	}

	// Every refused link, in digests.ts add's words: "refused <url or title>: <problems>". A link whose url repeats an
	// earlier one's (as digests.ts add compares urls) is queued once.
	const refused: string[] = [];
	const items: JsonObject[] = [];
	const urls = new Set<string>();
	for (let k = 0; k < links.length; k++) {
		const item: unknown = links[k];
		const problems = chatProblems(item).concat(entryProblems(item, "add"));
		if (problems.length > 0) {
			refused.push(
				`refused ${linkLabel(item, `link ${k + 1}`)}: ${problems.join("; ")}`,
			);
		} else if (isJsonObject(item) && typeof item.url === "string") {
			const url = normalizeUrl(item.url);
			if (!urls.has(url)) {
				urls.add(url);
				items.push(item);
			}
		}
	}
	if (refused.length > 0) {
		return {
			text: `${refused.join("\n")}\nNothing was queued.`,
			isError: true,
		};
	}
	return queueAndStart(context, "links", { links: items });
}

const addLinksTool: Tool = {
	name: "add_links",
	description:
		"Add news stories, articles and reports to the user's Liminal space digests (papers go through add_papers). " +
		"Fetch each page first and copy its title, source (the publisher) and published date from the page itself, " +
		"never from memory. If the page shows no date, take it from a news story that links the page, and add that " +
		"story under links. If a page doesn't load, don't add it. Leave the description out: the add run copies the " +
		"publisher's own. At most 5 links a call. The tool queues the request; the links are on the page a few " +
		"minutes later.",
	inputSchema: {
		type: "object",
		properties: {
			links: {
				type: "array",
				minItems: 1,
				maxItems: MAX_LINKS_PER_CALL,
				items: {
					type: "object",
					properties: {
						type: { type: "string", enum: ["news", "article", "report"] },
						title: { type: "string", description: "as the page gives it" },
						authors: { type: "array", items: { type: "string" } },
						published: {
							type: "string",
							pattern: "^\\d{4}-\\d{2}-\\d{2}$",
							description: "YYYY-MM-DD, as the page gives it",
						},
						source: { type: "string", description: "the publisher" },
						url: { type: "string", description: "the page's own address" },
						links: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									url: { type: "string" },
								},
								required: ["label", "url"],
								additionalProperties: false,
							},
						},
					},
					required: ["type", "title", "published", "source", "url"],
					additionalProperties: false,
				},
			},
		},
		required: ["links"],
		additionalProperties: false,
	},
	run: addLinks,
};

// An entry row's JSON as an object.
function entryOf(row: EntryRow): JsonObject {
	const entry: unknown = JSON.parse(row.json);
	if (!isJsonObject(entry)) {
		throw new Error(`the stored entry ${row.id} is not an object`);
	}
	return entry;
}

// The entry with its abstract and description cut to their first SEARCH_CUT characters, each marked as cut and saying
// where the whole text is.
function shortened(entry: JsonObject, date: string): JsonObject {
	const copy = Object.assign({}, entry);
	for (const field of ["abstract", "description"]) {
		const text = copy[field];
		if (typeof text !== "string") {
			continue;
		}
		// Characters as people count them, so a cut never splits a character outside the BMP.
		const characters = Array.from(text);
		if (characters.length > SEARCH_CUT) {
			copy[field] =
				`${characters.slice(0, SEARCH_CUT).join("")}… [cut: ${characters.length} characters in all; ` +
				`get_digest ${date} shows the whole text]`;
		}
	}
	return copy;
}

// search: entries holding every word of the query, the newest 20 first, each with the owner's notes. One statement walks the
// entries newest first through seq's index and stops at the 21st match; each word's comment and takeaway matches are
// lists of entry ids read from the comments and takeaways once, not once per entry. A 21st match only says that more match: no total is counted,
// which would read every entry.
async function search(
	args: JsonObject,
	context: ToolContext,
): Promise<ToolAnswer> {
	const { env, count } = context;
	const query = args.query;
	if (typeof query !== "string") {
		throw new BadParams("query must be text");
	}
	if (query.length > MAX_QUERY_LENGTH) {
		return {
			text: `The query is longer than ${MAX_QUERY_LENGTH} characters: use at most ${MAX_QUERY_LENGTH} characters.`,
			isError: true,
		};
	}
	const words = query.split(/\s+/).filter((word) => word !== "");
	if (words.length === 0) {
		return { text: "Give at least one word to search for.", isError: true };
	}
	if (words.length > MAX_QUERY_WORDS) {
		return {
			text: `The query has ${words.length} words: use at most ${MAX_QUERY_WORDS} words.`,
			isError: true,
		};
	}
	// Each word as a LIKE pattern, its % and _ escaped. D1 refuses a pattern longer than MAX_LIKE_PATTERN_BYTES.
	const patterns = words.map(
		(word) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`,
	);
	for (let k = 0; k < words.length; k++) {
		if (new TextEncoder().encode(patterns[k]).length > MAX_LIKE_PATTERN_BYTES) {
			return {
				text: `The word "${words[k]}" is too long to search for: each word can be at most ${MAX_LIKE_PATTERN_BYTES - 2} bytes (as many plain letters, fewer with accents, % or _).`,
				isError: true,
			};
		}
	}

	// Every word must match one of the entry's fields, one of the owner's comments on it or one of their takeaways, as written: LIKE's % and _ in a
	// word are escaped. LIKE ignores case for ASCII letters only.
	const clauses: string[] = [];
	for (let k = 1; k <= words.length; k++) {
		const fields = SEARCH_FIELDS.map(
			(field) => `json_extract(json, '$.${field}') LIKE ?${k} ESCAPE '\\'`,
		);
		const comments =
			"id IN (SELECT t.entry_id FROM comments c JOIN threads t ON t.id = c.thread_id " +
			`WHERE c.text LIKE ?${k} ESCAPE '\\')`;
		const takeaways = `id IN (SELECT entry_id FROM takeaways WHERE takeaway LIKE ?${k} ESCAPE '\\')`;
		clauses.push(`(${fields.join(" OR ")} OR ${comments} OR ${takeaways})`);
	}
	const sql =
		`SELECT id, date, json FROM entries WHERE ${clauses.join(" AND ")} ` +
		`ORDER BY seq DESC LIMIT ${SEARCH_SHOWN + 1}`;
	const answer = await countOne(
		env.DB.prepare(sql)
			.bind(...patterns)
			.all<EntryRow>(),
		count,
	);
	if (answer.results.length === 0) {
		return { text: `No entry matches "${query}".`, isError: false };
	}
	const rows = answer.results.slice(0, SEARCH_SHOWN);
	const notes = await notesFor(
		env.DB,
		rows.map((row) => row.id),
		count,
	);
	let head = `# Search: "${query}"\n\n`;
	if (answer.results.length > SEARCH_SHOWN) {
		head += `The newest ${SEARCH_SHOWN}, newest first. More entries match: add words to narrow the search.\n`;
	} else if (rows.length === 1) {
		head += "1 entry matches.\n";
	} else {
		head += `${rows.length} entries match, newest first.\n`;
	}
	const sections = rows.map((row) =>
		entryMarkdown(
			shortened(entryOf(row), row.date),
			row.date,
			notes.get(row.id),
		),
	);
	return { text: `${head}\n${sections.join("\n")}`, isError: false };
}

const searchTool: Tool = {
	name: "search",
	description:
		"Search the user's Liminal space digests: papers, news, articles and reports, with what they made of each (read " +
		"marks, tags, Dislike, OK or Like marks, their comments with the passage each is on, and their takeaways with their " +
		"recall questions). An entry matches when it holds every word of the query, in any case, in its title, " +
		"authors, abstract, description, source or venue, or in the user's comments or takeaways on it. Shows the newest 20 matches, newest first; abstracts and descriptions are cut " +
		"to their first 300 characters, and get_digest with the entry's date shows them whole. At most 10 words.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				maxLength: MAX_QUERY_LENGTH,
				description: "words that must all appear, such as: steering vectors",
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	run: search,
};

// "There is no digest on <date>", naming the nearest earlier and later days that have one.
async function nearestDays(
	env: Env,
	date: string,
	count: (cost: QueryCost) => void,
): Promise<string> {
	const answers = await runBatch<{ date: string | null }>(
		env.DB,
		[
			env.DB.prepare(
				"SELECT MAX(date) AS date FROM entries WHERE date < ?1",
			).bind(date),
			env.DB.prepare(
				"SELECT MIN(date) AS date FROM entries WHERE date > ?1",
			).bind(date),
		],
		count,
	);
	let before = "none before it";
	let after = "none after it";
	const earlier = answers[0];
	const later = answers[1];
	if (
		earlier !== undefined &&
		earlier.results[0] !== undefined &&
		earlier.results[0].date !== null
	) {
		before = `${earlier.results[0].date} before it`;
	}
	if (
		later !== undefined &&
		later.results[0] !== undefined &&
		later.results[0].date !== null
	) {
		after = `${later.results[0].date} after it`;
	}
	return `There is no digest on ${date}. The nearest: ${before}, ${after}.`;
}

// get_digest: one day's entries in page order with the owner's notes; the latest day when no date is given. One statement
// reads the day through entries_date (the latest date is that index's last entry). A date without a digest names the
// nearest earlier and later dates, each found through the same index.
async function getDigest(
	args: JsonObject,
	context: ToolContext,
): Promise<ToolAnswer> {
	const { env, count } = context;
	const asked = args.date;
	if (asked !== undefined && typeof asked !== "string") {
		throw new BadParams("date must be text");
	}
	if (typeof asked === "string" && !isDay(asked)) {
		return {
			text: `The date must look like 2026-10-20 (YYYY-MM-DD), not "${asked}".`,
			isError: true,
		};
	}
	let date: string | null = null;
	if (typeof asked === "string") {
		date = asked;
	}
	const answer = await countOne(
		env.DB.prepare(
			"SELECT id, date, json FROM entries WHERE date = COALESCE(?1, (SELECT MAX(date) FROM entries)) ORDER BY seq",
		)
			.bind(date)
			.all<EntryRow>(),
		count,
	);
	const rows = answer.results;
	const first = rows[0];
	if (first === undefined) {
		if (date === null) {
			return { text: "There are no digests yet.", isError: false };
		}
		return { text: await nearestDays(env, date, count), isError: true };
	}
	const notes = await notesFor(
		env.DB,
		rows.map((row) => row.id),
		count,
	);
	const text = digestMarkdown(
		first.date,
		rows.map(entryOf),
		notes,
		MAX_DIGEST_BYTES,
	);
	return { text: text, isError: false };
}

const getDigestTool: Tool = {
	name: "get_digest",
	description:
		"One day's Liminal space digest in full, in the order the page shows it (papers first), each entry with " +
		"the user's read marks, tags, Dislike, OK or Like marks, comments, and takeaways with their recall questions. Without a date it gives the latest digest. A " +
		"date without a digest names the nearest days that have one.",
	inputSchema: {
		type: "object",
		properties: {
			date: {
				type: "string",
				pattern: "^\\d{4}-\\d{2}-\\d{2}$",
				description: "YYYY-MM-DD; leave it out for the latest digest",
			},
		},
		additionalProperties: false,
	},
	run: getDigest,
};

// propose_takeaway: save the owner's takeaway and its recall question on an entry the digests hold, naming the app the chat
// runs in. An empty takeaway, a missing question or an id no digest holds is refused, and nothing is saved; a takeaway
// or question longer than OWNER_TEXT_CHARS (the owner route's cap) is invalid input.
async function proposeTakeaway(
	args: JsonObject,
	context: ToolContext,
): Promise<ToolAnswer> {
	const { env, count } = context;
	const id = args.id;
	const takeaway = args.takeaway;
	const question = args.question;
	const app = args.app;
	if (typeof id !== "string") {
		throw new BadParams("id must be an entry id");
	}
	if (app !== "claude.ai" && app !== "ChatGPT") {
		throw new BadParams('app must be "claude.ai" or "ChatGPT"');
	}
	if (typeof takeaway !== "string" || takeaway.trim() === "") {
		return {
			text: "The takeaway is empty: give the user's takeaway in their own words. Nothing was saved.",
			isError: true,
		};
	}
	if (typeof question !== "string" || question.trim() === "") {
		return {
			text: "The question is missing: give one recall question whose answer is the takeaway. Nothing was saved.",
			isError: true,
		};
	}
	if (takeaway.length > OWNER_TEXT_CHARS) {
		throw new BadParams(
			`the takeaway is too long: at most ${OWNER_TEXT_CHARS} characters`,
		);
	}
	if (question.length > OWNER_TEXT_CHARS) {
		throw new BadParams(
			`the recall question is too long: at most ${OWNER_TEXT_CHARS} characters`,
		);
	}
	const title = await saveProposedTakeaway(
		env.DB,
		id,
		takeaway,
		question,
		app,
		count,
	);
	if (title === null) {
		return {
			text: `No entry in the digests has the id "${id}". Give the id as search or get_digest shows it. Nothing was saved.`,
			isError: true,
		};
	}
	return {
		text: `Saved the takeaway on "${title}". It shows in the entry's Takeaway panel on the user's page.`,
		isError: false,
	};
}

const proposeTakeawayTool: Tool = {
	name: "propose_takeaway",
	description:
		"Save the user's takeaway on one entry of their Liminal space digests, with one recall question whose answer is " +
		"the takeaway. The takeaway is the user's own sentence, in their words: ask them for it, point out what the " +
		"discussion settled that it misses, and draft the question. Call this only after the user agreed to both. Give " +
		"the entry's id as search, get_digest or the page's Copy shows it (arxiv:2507.11473, doi:..., url:...), and " +
		"the app this chat runs in. The takeaway shows in the entry's Takeaway panel on the user's page.",
	inputSchema: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "the entry's id, such as arxiv:2507.11473",
			},
			takeaway: {
				type: "string",
				description: "the user's takeaway, in their own words",
			},
			question: {
				type: "string",
				description: "one recall question whose answer is the takeaway",
			},
			app: {
				type: "string",
				enum: TAKEAWAY_APPS,
				description:
					"the app this chat runs in: claude.ai for any Claude app, ChatGPT for ChatGPT",
			},
		},
		required: ["id", "takeaway", "question", "app"],
		additionalProperties: false,
	},
	run: proposeTakeaway,
};

// The five tools, in the order tools/list gives them to the model.
export const TOOLS: Tool[] = [
	addPapersTool,
	addLinksTool,
	searchTool,
	getDigestTool,
	proposeTakeawayTool,
];
