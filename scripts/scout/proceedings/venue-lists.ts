// Downloading the conference lists of interests.md and reading their titles in each list format.
import { decodeHTML } from "entities";
import { request } from "../../lib/http.ts";
import type { ListTitle, ReadList, Run } from "../arxiv/search.ts";
import type { ConferenceList, Topic } from "../plan/interests.ts";
import { normaliseTitle, phraseMatches } from "../plan/title-match.ts";

// What download gives: an answer from the host, or the problem when none came.
type Download =
	| {
			status: number;
			ok: boolean;
			etag: string | null;
			lastModified: string | null;
			body: string;
			problem?: undefined;
	  }
	| { problem: string; status?: undefined; ok?: undefined; body?: undefined };
// One kept list of lists.json: the validators of its last download, the date it was kept, and its titles.
type KeptList = {
	etag: string | null;
	lastModified: string | null;
	kept: string;
	titles: ListTitle[];
};

// One paper of a JSON list: the index of its first row, and its distinct names.
type JsonPaper = { first: number; names: string[] };

// CSV text -> rows, each an array of fields, as RFC 4180 reads it: a field in double quotes may hold commas, line
// breaks and doubled quotes (""), as FAccT's abstracts do. A line break at the very end ends the last row.
export function parseCsv(text: string): string[][] {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false; // inside a field that started with a double quote
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				field += '"';
				i += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"' && field === "") {
			quoted = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			// "\r\n" is one line break.
			if (char === "\r" && text[i + 1] === "\n") {
				i += 1;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += char;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

// Text from a list as plain text: every HTML entity decoded once, runs of whitespace collapsed.
function plainText(text: string) {
	return decodeHTML(text).replace(/\s+/g, " ").trim();
}

// HTML as plain text: tags removed, then entities decoded, so an escaped "&lt;" can't become a tag.
function htmlText(html: string) {
	return plainText(html.replace(/<[^>]*>/g, ""));
}

// FAccT: a CSV whose "Title" column holds the titles.
function csvTitles(body: string) {
	const rows = parseCsv(body);
	// The first row is undefined only when there are no rows.
	const header = rows[0];
	if (header === undefined) {
		return [];
	}
	const column = header.map((name) => name.trim()).indexOf("Title");
	if (column === -1) {
		return [];
	}
	const titles = [];
	for (const row of rows.slice(1)) {
		// The cell is undefined only when the row is shorter than the column.
		const cell = row[column];
		if (cell !== undefined) {
			titles.push(plainText(cell));
		}
	}
	return titles;
}

// AIES (WordPress): one <tr> per paper in each <table class="has-fixed-layout">, with three <td> cells: number, title,
// authors; on the poster and lightning-talk pages number, authors, title.
function wordpressTitles(body: string, path: string) {
	let column = 1; // the second cell
	if (
		path.toLowerCase().includes("poster") ||
		path.toLowerCase().includes("lightning")
	) {
		column = 2; // the third cell
	}
	const titles = [];
	for (const table of body.matchAll(
		/<table class="has-fixed-layout"[\s\S]*?<\/table>/g,
	)) {
		for (const row of table[0].matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/g)) {
			const rowContent = row[1] || "";
			const cells = [];
			for (const cell of rowContent.matchAll(
				/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g,
			)) {
				cells.push(cell[1] || "");
			}
			// The cell is undefined only when the row has too few cells.
			const titleCell = cells[column];
			if (titleCell !== undefined) {
				titles.push(htmlText(titleCell));
			}
		}
	}
	return titles;
}

// PETS: in each <div class="accepted-list">, one <li> per paper, its title being the text before its first tag (an
// artifact link, or the <br /> before the italic author line).
function petsTitles(body: string) {
	const titles = [];
	for (const list of body.matchAll(
		/<div class="accepted-list"[^>]*>([\s\S]*?)<\/div>/g,
	)) {
		const listContent = list[1] || "";
		for (const item of listContent.matchAll(/<li(?:\s[^>]*)?>([^<]*)/g)) {
			titles.push(plainText(item[1] || ""));
		}
	}
	return titles;
}

// ACL (Jekyll): in <section class="page__content">, one <li> per paper, its title being its content up to the first
// <br>, tags removed. Cutting at <br> keeps the titles whose "*" Markdown turned into <em> ("T*: Progressive ...").
function jekyllTitles(body: string) {
	const start = body.indexOf('<section class="page__content"');
	let end = body.indexOf("</section>", start);
	if (end === -1) {
		end = body.length;
	}
	const titles = [];
	for (const item of body
		.slice(start, end)
		.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)) {
		const content = item[1] || "";
		const beforeBreak = content.split(/<br/i)[0] || "";
		titles.push(htmlText(beforeBreak));
	}
	return titles;
}

// The OpenReview id in a paper_url such as "https://openreview.net/forum?id=xJye25jdwj"; null when there is none, or
// when it is a placeholder starting with a year, as ICLR's oral rows carry ("forum?id=2026-Oral--11330-7ac2ef22").
function openReviewId(paperUrl: unknown) {
	if (typeof paperUrl !== "string") {
		return null;
	}
	const match = paperUrl.match(/forum\?id=([^&#\s]+)/);
	if (match === null) {
		return null;
	}
	const id = match[1] || "";
	if (/^\d{4}-/.test(id)) {
		return null;
	}
	return id;
}

// NeurIPS, ICML and ICLR: { results: [{ name, paper_url, ... }] }. A paper is the rows sharing an OpenReview id: some
// rows appear several times, and an oral repeats its poster under another id, sometimes with another name. A row
// without a real OpenReview id joins the paper that has its title, else stands alone. Returns each paper's distinct
// names, in the order the papers first appear.
function jsonPapers(body: string) {
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return [];
	}
	if (
		data === null ||
		typeof data !== "object" ||
		!("results" in data) ||
		!Array.isArray(data.results)
	) {
		return [];
	}
	const results: unknown[] = data.results;
	const papers: JsonPaper[] = [];
	const byForum = new Map<string, JsonPaper>(); // OpenReview id -> paper
	const byTitle = new Map<string, JsonPaper>(); // normalised name -> paper
	const withoutForum: { index: number; name: string }[] = []; // joined after every OpenReview id is known
	// Add a name to a paper unless it already has it, ignoring case and punctuation.
	function addName(paper: JsonPaper, name: string) {
		const key = normaliseTitle(name);
		if (!byTitle.has(key)) {
			byTitle.set(key, paper);
		}
		for (const known of paper.names) {
			if (normaliseTitle(known) === key) {
				return;
			}
		}
		paper.names.push(name);
	}
	for (let index = 0; index < results.length; index++) {
		const row = results[index];
		if (
			row === null ||
			typeof row !== "object" ||
			!("name" in row) ||
			typeof row.name !== "string"
		) {
			continue;
		}
		const name = plainText(row.name);
		if (normaliseTitle(name) === "") {
			continue;
		}
		let paperUrl: unknown;
		if ("paper_url" in row) {
			paperUrl = row.paper_url;
		}
		const forum = openReviewId(paperUrl);
		if (forum === null) {
			withoutForum.push({ index: index, name: name });
			continue;
		}
		let paper = byForum.get(forum);
		if (paper === undefined) {
			paper = { first: index, names: [] };
			byForum.set(forum, paper);
			papers.push(paper);
		}
		addName(paper, name);
	}
	for (const row of withoutForum) {
		let paper = byTitle.get(normaliseTitle(row.name));
		if (paper === undefined) {
			paper = { first: row.index, names: [] };
			papers.push(paper);
		}
		addName(paper, row.name);
	}
	papers.sort((a, b) => a.first - b.first);
	return papers.map((paper) => paper.names);
}

// Titles in list order with empty ones dropped and each title kept once, ignoring case and punctuation.
function distinctTitles(titles: string[]) {
	const seen = new Set<string>();
	const distinct = [];
	for (const title of titles) {
		const key = normaliseTitle(title);
		if (key !== "" && !seen.has(key)) {
			seen.add(key);
			distinct.push(title);
		}
	}
	return distinct;
}

// The titles of one accepted-paper list, in list order, read in its format, chosen by the URL and the content; [] when
// the content is in none of them. One item per paper: its title, or for a JSON paper listed under several names (an
// oral named apart from its poster) the array of those names, since either may be the arXiv title.
export function listTitles(url: string, body: string): ListTitle[] {
	const path = new URL(url).pathname;
	if (path.endsWith(".json")) {
		return jsonPapers(body).map(listTitle);
	}
	if (path.endsWith(".csv")) {
		return distinctTitles(csvTitles(body));
	}
	if (body.includes('<table class="has-fixed-layout"')) {
		return distinctTitles(wordpressTitles(body, path));
	}
	if (body.includes('<div class="accepted-list"')) {
		return distinctTitles(petsTitles(body));
	}
	if (body.includes('<section class="page__content"')) {
		return distinctTitles(jekyllTitles(body));
	}
	return [];
}

// One paper of a list as listTitles gives it: its one name as a string, or the array of its names.
function listTitle(names: string[]): ListTitle {
	const firstName = names[0];
	if (names.length === 1 && firstName !== undefined) {
		return firstName;
	}
	return names;
}

// One paper of a list as its names: a title kept as a string is one name.
function paperNames(title: ListTitle) {
	if (Array.isArray(title)) {
		return title;
	}
	return [title];
}

// A kept copy's titles with a fresh download's added: every kept title stays, in the order first seen, and each fresh
// title the copy lacks follows them. A paper listed under several names is one item; a fresh name of a paper already
// kept joins that paper's names. Titles are compared normalised, as everywhere else.
function unionTitles(keptTitles: ListTitle[], freshTitles: ListTitle[]) {
	const papers: string[][] = []; // each paper as the array of its names
	const byName = new Map<string, string[]>(); // normalised name -> the paper holding it
	// Add one paper's names: to the first paper already holding one of them, else as a paper of its own.
	function addPaper(names: string[]) {
		let paper: string[] | null = null;
		for (const name of names) {
			const known = byName.get(normaliseTitle(name));
			if (known !== undefined) {
				paper = known;
				break;
			}
		}
		if (paper === null) {
			paper = [];
			papers.push(paper);
		}
		for (const name of names) {
			const key = normaliseTitle(name);
			if (!byName.has(key)) {
				byName.set(key, paper);
				paper.push(name);
			}
		}
	}
	for (const title of keptTitles) {
		addPaper(paperNames(title));
	}
	for (const title of freshTitles) {
		addPaper(paperNames(title));
	}
	// A paper with one name is a string again, as listTitles gives it.
	return papers.map(listTitle);
}

// One GET to a list host or Google News, with this script's user agent and a 30 s limit. Each is awaited before the next
// starts, so they go one at a time. Returns { status, ok, etag, lastModified, body }, or { problem } when no answer
// came, worded like arxivRequest's: "gave no answer within 30 seconds" or "could not be reached (ENOTFOUND)".
export async function download(
	url: string,
	headers: Record<string, string>,
): Promise<Download> {
	const answer = await request(url, { headers: headers });
	if ("problem" in answer) {
		return { problem: answer.problem };
	}
	return {
		status: answer.status,
		ok: answer.ok,
		etag: answer.headers.get("etag"),
		lastModified: answer.headers.get("last-modified"),
		body: answer.text(),
	};
}

// What went wrong with a download, in words that finish "<venue> list ..." or "Google News ...": "answered HTTP 503",
// or no answer.
export function downloadProblem(answer: Download): string {
	if (answer.problem) {
		return answer.problem;
	}
	return `answered HTTP ${answer.status}`;
}

// One list kept in lists.json; null when there is none, or when its titles aren't an array.
function keptListOf(value: unknown): KeptList | null {
	if (
		value === undefined ||
		value === null ||
		typeof value !== "object" ||
		!("titles" in value) ||
		!Array.isArray(value.titles)
	) {
		return null;
	}
	// Only the titles are checked: the rest is read as readLists wrote it in an earlier run.
	return value as KeptList;
}

// Download every list, in interests.md order, and read its titles. A list kept from an earlier run is downloaded only
// if it changed (If-None-Match, If-Modified-Since); a 304 means the kept titles still hold, and a fresh download adds
// its titles to them in `keptLists`, dropping none. A list that can't be downloaded, or whose page holds no titles,
// falls back to its kept copy.
// Returns per list { venue, url, published, titles, copyKept, problem }: copyKept is the date of the kept copy used
// after a failed download or a page with no titles, problem what happened when a download failed and there is no copy.
export async function readLists(
	lists: ConferenceList[],
	keptLists: Record<string, unknown>,
	today: string,
	run: Run,
): Promise<ReadList[]> {
	const read: ReadList[] = [];
	for (const list of lists) {
		const result: ReadList = {
			venue: list.venue,
			url: list.url,
			published: list.published,
			titles: [],
			copyKept: null,
			problem: null,
			matching: [], // filled in by main once every list is read
		};
		read.push(result);
		const kept = keptListOf(keptLists[list.url]);
		const headers: Record<string, string> = {};
		if (kept !== null && kept.etag) {
			headers["If-None-Match"] = kept.etag;
		}
		if (kept !== null && kept.lastModified) {
			headers["If-Modified-Since"] = kept.lastModified;
		}

		// biome-ignore lint/performance/noAwaitInLoops: one list at a time, so only one request to a conference site is open
		const answer = await download(list.url, headers);
		if (answer.status === 304 && kept !== null) {
			result.titles = kept.titles;
		} else if (answer.ok) {
			result.titles = listTitles(list.url, answer.body);
			// A page in a format the script doesn't read (a bot challenge, a maintenance or consent page) has no titles. For
			// the reader that is a failed download: it doesn't replace a kept copy, and the kept copy's titles are used.
			if (result.titles.length === 0) {
				console.error(
					`search.ts: no titles found in the ${list.venue} list (${list.url})`,
				);
				run.failed = true;
				if (kept !== null) {
					result.titles = kept.titles;
					result.copyKept = kept.kept;
				}
			} else {
				// A list page can drop a paper for a day: the kept titles stay and the download adds its new ones.
				if (kept !== null) {
					result.titles = unionTitles(kept.titles, result.titles);
				}
				keptLists[list.url] = {
					etag: answer.etag,
					lastModified: answer.lastModified,
					kept: today,
					titles: result.titles,
				};
			}
		} else {
			const problem = downloadProblem(answer);
			console.error(`search.ts: ${list.venue} list ${problem} (${list.url})`);
			run.failed = true;
			if (kept !== null) {
				result.titles = kept.titles;
				result.copyKept = kept.kept;
			} else {
				result.problem = problem;
			}
		}
	}
	return read;
}

// True when one of a paper's names holds a phrase of any topic.
function holdsAPhrase(names: string[], topics: Topic[]) {
	return names.some((name) =>
		topics.some((topic) =>
			topic.phrases.some((phrase) => phraseMatches(phrase, name)),
		),
	);
}

// The papers of a list that hold a topic phrase, each as its names.
export function matchingPapers(
	titles: ListTitle[],
	topics: Topic[],
): string[][] {
	const matching = [];
	for (const title of titles) {
		const names = paperNames(title);
		if (holdsAPhrase(names, topics)) {
			matching.push(names);
		}
	}
	return matching;
}
