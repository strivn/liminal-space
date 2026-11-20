// Copy a publisher's own description of a page into the digest entry with that URL, so no model retypes it.
// With --summary, write a summary the scout or a chat wrote instead, labelled "[AI Summarized] ", fetching nothing.
// Usage: node scripts/scout/web/describe.ts <digests file> <url> [<url> ...]
//        node scripts/scout/web/describe.ts <digests file> --summary <url> <summary>
import { existsSync } from "node:fs";
import {
	request as httpRequest,
	type IncomingHttpHeaders,
	type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import {
	cutAtWord,
	isUsableDescription,
	withoutControlCharacters,
} from "../../../shared/entry-checks.ts";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import {
	type ParsedLine,
	readDigests,
	writeChangedLines,
} from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { failureReason } from "../../lib/fetch-problem.ts";
import { attribute, type Tag, tagsNamed } from "../../lib/html.ts";
import { FetchRefused, publicAddress } from "../../lib/public-address.ts";

const fail: Fail = failer("describe.ts");

// Two lines, one per form; the first is the line the fetch form has always printed.
const USAGE = [
	"usage: node scripts/scout/web/describe.ts <digests file> <url> [<url> ...]",
	"   or: node scripts/scout/web/describe.ts <digests file> --summary <url> <summary>",
].join("\n");
// Papers carry arXiv's abstract instead. unknown[], so includes() takes an entry's type before it is checked.
const DESCRIBED_TYPES: unknown[] = ["news", "article", "report"];
const FETCH_TIMEOUT_MS = CONSTANTS.requestTimeoutMs;
// Redirects followed for one page, as many as fulltext.sh follows.
const MAX_REDIRECTS = 5;
// The most of a page that is read.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
// Marks a description a model wrote, as against one copied from the publisher.
const SUMMARY_LABEL = "[AI Summarized] ";
// The label without its trailing space, so a summary starting "[AI Summarized]" is recognised with or without it.
const BARE_LABEL = SUMMARY_LABEL.trim();

// The most characters of a copied description kept; a --summary is not cut.
const DESCRIPTION_MAX = 500;

// One news, article or report entry, with the index of the line it sits on.
type EntryMatch = { index: number; entry: JsonObject };

// The part of a page its descriptions are read from: what comes before the head's end or the body's start, so a
// <meta> a reader planted in the page's text (a comment, a quoted post) is not the publisher's. A page that names
// neither is read whole.
function headOf(html: string) {
	const end = html.search(/<\/head\b|<body\b/i);
	if (end === -1) {
		return html;
	}
	return html.slice(0, end);
}

// The content of the first of these <meta> tags whose property or name is `key` (any case), or null.
function metaContent(metaTags: Tag[], key: string) {
	for (const tag of metaTags) {
		const tagKey =
			attribute(tag.text, "property") || attribute(tag.text, "name") || "";
		if (tagKey.toLowerCase() === key) {
			return attribute(tag.text, "content");
		}
	}
	return null;
}

// The character set a Content-Type value names: "text/html; charset=windows-1252" -> "windows-1252"; null when none.
function charsetIn(contentType: string) {
	const match = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
	if (match === null) {
		return null;
	}
	return match[1];
}

// The character set a <meta charset> or <meta http-equiv="Content-Type"> tag names in a page's first 4096 bytes;
// null when none does.
function metaCharset(bytes: Buffer) {
	// latin1 turns each byte into one character, so the tags' ASCII reads the same whatever the page's character set.
	const head = bytes.subarray(0, 4096).toString("latin1");
	for (const tag of tagsNamed(head, ["meta"])) {
		const charset = attribute(tag.text, "charset");
		if (charset !== null && charset.trim() !== "") {
			return charset.trim();
		}
		const httpEquiv = attribute(tag.text, "http-equiv") || "";
		if (httpEquiv.toLowerCase() === "content-type") {
			const declared = charsetIn(attribute(tag.text, "content") || "");
			if (declared !== null) {
				return declared;
			}
		}
	}
	return null;
}

// A page's bytes as text, in the character set the Content-Type header names, else the one a <meta> tag names,
// else UTF-8. A name TextDecoder doesn't know also falls back to UTF-8.
function decodePage(bytes: Buffer, contentType: string) {
	const charset = charsetIn(contentType) || metaCharset(bytes) || "utf-8";
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset);
	} catch {
		decoder = new TextDecoder("utf-8"); // RangeError: the name is not a character set TextDecoder knows
	}
	return decoder.decode(bytes);
}

// One character reference ended by ";": numeric, hex or named.
const REFERENCE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;

// The markup characters a page's text may name on purpose, so the second pass leaves their references as written.
const MARKUP_CHARACTERS = ["<", ">", "&"];

// A reference left after the first pass, decoded again unless it stands for a markup character. Some publishers
// (ANTARA News) escape their text twice, so "&amp;#39;" means an apostrophe.
function decodeTwiceEscaped(reference: string) {
	const character = decodeHTML(reference);
	if (MARKUP_CHARACTERS.includes(character)) {
		return reference;
	}
	return character;
}

// An attribute value as plain text: every HTML entity decoded (attribute rules), references a twice-escaping page
// leaves decoded once more, runs of whitespace collapsed, and no control character: a line break has become a space
// by then, and an escape sequence or a NUL would otherwise reach a terminal or the Markdown that prints the text.
function plainText(value: string) {
	const decoded = decodeHTMLAttribute(value)
		.replace(REFERENCE, decodeTwiceEscaped)
		.replace(/\s+/g, " ");
	return withoutControlCharacters(decoded).replace(/\s+/g, " ").trim();
}

// The publisher's descriptions of a page as plain text: og:description, then the meta description, each read from
// the page's head; empty ones left out.
export function pageDescriptions(html: string): string[] {
	const metaTags = tagsNamed(headOf(html), ["meta"]);
	const descriptions: string[] = [];
	for (const key of ["og:description", "description"]) {
		const content = metaContent(metaTags, key);
		if (content !== null && plainText(content) !== "") {
			descriptions.push(plainText(content));
		}
	}
	return descriptions;
}

// The first of a page's descriptions that is usable, cut to DESCRIPTION_MAX characters; null when none is.
export function pageDescription(html: string): string | null {
	const usable = pageDescriptions(html).find(isUsableDescription);
	if (usable === undefined) {
		return null;
	}
	return cutAtWord(usable, DESCRIPTION_MAX);
}

// A summary as the one-line description it becomes: runs of whitespace (line breaks included) as one space, trimmed,
// and labelled "[AI Summarized] " once. null when nothing is left; a summary that is only the label counts as empty.
export function summaryText(text: string): string | null {
	let words = text.replace(/\s+/g, " ").trim();
	// A summary that already carries the label keeps only what follows it, so the label is never written twice.
	if (words.startsWith(BARE_LABEL)) {
		words = words.slice(BARE_LABEL.length).trim();
	}
	if (words === "") {
		return null;
	}
	return SUMMARY_LABEL + words;
}

// An entry has a description when the field holds some text; "" or spaces count as none.
function hasDescription(entry: JsonObject) {
	return (
		typeof entry.description === "string" && entry.description.trim() !== ""
	);
}

// Every entry with this URL, with the index of the line it sits on: the news, articles and reports when `described`
// is true, else the entries of other types (papers).
function entriesWithUrl(
	digests: ParsedLine[],
	url: string,
	described: boolean,
) {
	const matches: EntryMatch[] = [];
	for (const { index, digest } of digests) {
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) {
			continue;
		}
		const entries: unknown[] = digest.entries;
		for (const entry of entries) {
			if (!isJsonObject(entry)) {
				continue;
			}
			if (
				DESCRIBED_TYPES.includes(entry.type) === described &&
				entry.url === url
			) {
				matches.push({ index: index, entry: entry });
			}
		}
	}
	return matches;
}

// An entry's id for messages. The schema lets news, articles and reports leave it out; it is then "url:" + url.
function idOf(entry: JsonObject) {
	return entry.id || `url:${entry.url}`;
}

// The --summary form: write a summary the scout or a chat wrote as the description of the entry with this URL.
// No page is fetched. A summary only fills an empty description; it never replaces one.
function addSummary(args: string[]) {
	// Exactly <digests file> --summary <url> <summary>; checked before anything is read.
	const file = args[0];
	const url = args[2];
	const summary = args[3];
	if (
		args.length !== 4 ||
		args[1] !== "--summary" ||
		file === undefined ||
		url === undefined ||
		summary === undefined
	) {
		console.error("describe.ts: --summary needs a URL and a summary");
		console.error(USAGE);
		process.exit(1);
	}
	const description = summaryText(summary);
	if (description === null) {
		fail("the summary is empty");
	}
	if (!existsSync(file)) {
		fail(`${file} doesn't exist`);
	}

	// Find the entry: a news, article or report with exactly this URL.
	const current = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	const matches = entriesWithUrl(current.digests, url, true);
	const firstMatch = matches[0];
	if (firstMatch === undefined) {
		const other = entriesWithUrl(current.digests, url, false)[0];
		if (other !== undefined) {
			fail(
				`only news, articles and reports take a summary (${idOf(other.entry)})`,
			);
		}
		fail(`no news, article or report has the URL ${url}`);
	}

	// Fill every matching entry still without a description, as the fetch form does.
	const changedLines = new Set<number>();
	const summarized: unknown[] = [];
	for (const match of matches) {
		if (!hasDescription(match.entry)) {
			match.entry.description = description;
			changedLines.add(match.index);
			summarized.push(idOf(match.entry));
		}
	}
	if (summarized.length === 0) {
		fail(
			`${idOf(firstMatch.entry)} already has a description; a summary never replaces it`,
		);
	}

	writeChangedLines(file, current, changedLines, (_real, code) =>
		fail(`couldn't write ${file}: ${code}`),
	);
	for (const id of summarized) {
		console.log(`summarized ${id}`);
	}
}

// One hop of a page fetch: the answer's status, headers and body stream, and close() to drop the connection. The
// connection goes to `checked.address` when given, the address publicAddress just checked, so a second DNS answer
// can't send it elsewhere; the port is the URL's own, the same one publicAddress read (fulltext.sh pins curl the same way with --connect-to); TLS still sees the
// URL's hostname. A null `checked` (a local stand-in LIMINAL_ALLOW_LOCAL names) resolves the name as usual.
// Redirects are not followed here. The request sends the shared user agent and no Accept-Encoding, so the body
// arrives as it is; `signal` ends the request and the body alike.
export type PageAnswer = {
	status: number;
	headers: IncomingHttpHeaders;
	body: Readable;
	close: () => void;
};
export function fetchPage(
	address: string,
	checked: { address: string; port: string } | null,
	signal: AbortSignal,
): Promise<PageAnswer> {
	const url = new URL(address);
	// agent: false, so a connection is never reused from an earlier hop: each goes where its own check said.
	const options: RequestOptions = {
		headers: { "user-agent": CONSTANTS.userAgent },
		signal: signal,
		agent: false,
	};
	if (checked !== null) {
		// Answer the lookup with the address just checked instead of resolving the name again. The URL keeps the
		// hostname (and its port), so the Host header, TLS server name and certificate check all use it. Node asks
		// with { all: true } under autoSelectFamily and without it otherwise, so both shapes are answered.
		const family = isIP(checked.address);
		options.lookup = ((
			_host: string,
			lookupOptions: { all?: boolean },
			callback: (...answer: unknown[]) => void,
		) => {
			if (lookupOptions.all) {
				callback(null, [{ address: checked.address, family: family }]);
			} else {
				callback(null, checked.address, family);
			}
		}) as RequestOptions["lookup"];
	}
	let request = httpRequest;
	if (url.protocol === "https:") {
		request = httpsRequest;
	}
	return new Promise((resolve, reject) => {
		const req = request(url, options, (res) => {
			resolve({
				status: res.statusCode || 0,
				headers: res.headers,
				body: res,
				close: () => req.destroy(),
			});
		});
		req.on("error", reject);
		req.end();
	});
}

// The body of a page answer, whole, or null when it is larger than MAX_PAGE_BYTES (by its Content-Length, or once that
// many bytes arrived), the connection then closed.
export async function readPageBody(
	response: PageAnswer,
): Promise<Buffer | null> {
	// A declared length past the limit: nothing of the body is read. Number("") is 0 and Number(undefined) is NaN,
	// neither larger, so a page without the header is read and counted.
	if (Number(response.headers["content-length"]) > MAX_PAGE_BYTES) {
		response.close();
		return null;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		const bytes = Buffer.from(chunk);
		total += bytes.length;
		if (total > MAX_PAGE_BYTES) {
			response.close();
			return null;
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

// Fetch one page and read its description. Returns { description } or { problem }.
// Only addresses on the public internet are fetched (public-address.ts), checked again at each redirect, and the
// connection goes to the address checked (fetchPage): a link added through the connector is described on a GitHub
// runner, and a page could otherwise send this fetch to the runner's own services. A redirect to anything but http or
// https is refused, and the body is read up to MAX_PAGE_BYTES.
async function describePage(
	url: string,
): Promise<{ problem: string } | { description: string }> {
	let html: string;
	let address = url;
	try {
		const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		let response: PageAnswer | null = null;
		for (let hop = 0; hop <= MAX_REDIRECTS && response === null; hop++) {
			// A redirect target off the web (ftp:, file:, javascript:) is refused before any lookup; the first address
			// is http(s) already (entry-checks.ts), so the message names a redirect.
			const protocol = new URL(address).protocol;
			if (protocol !== "http:" && protocol !== "https:") {
				return {
					problem: `could not fetch ${url}: redirect to ${address}: not http or https`,
				};
			}
			// biome-ignore lint/performance/noAwaitInLoops: each hop's address comes from the answer to the one before
			const checked = await publicAddress(address);
			const answer = await fetchPage(address, checked, signal);
			const location = answer.headers.location;
			if (
				answer.status >= 300 &&
				answer.status < 400 &&
				location !== undefined
			) {
				answer.close();
				address = new URL(location, address).href;
			} else {
				response = answer;
			}
		}
		if (response === null) {
			return {
				problem: `could not fetch ${url}: more than ${MAX_REDIRECTS} redirects`,
			};
		}
		if (response.status < 200 || response.status >= 300) {
			response.close();
			return { problem: `could not fetch ${url}: HTTP ${response.status}` };
		}
		// Inside the try: the connection can also drop while the body arrives. Bytes, not text, which would decode
		// every page as UTF-8; at most MAX_PAGE_BYTES, by the declared length and by what arrives.
		const bytes = await readPageBody(response);
		if (bytes === null) {
			return { problem: `could not fetch ${url}: larger than 2 MB` };
		}
		html = decodePage(bytes, response.headers["content-type"] || "");
	} catch (error) {
		if (error instanceof FetchRefused) {
			let hop = "";
			if (address !== url) {
				hop = `redirect to ${address}: `;
			}
			return { problem: `could not fetch ${url}: ${hop}${error.message}` };
		}
		// No time-limit wording here: a timeout prints the error's own message.
		return { problem: `could not fetch ${url}: ${failureReason(error)}` };
	}
	if (pageDescriptions(html).length === 0) {
		return { problem: `no description on the page: ${url}` };
	}
	const description = pageDescription(html);
	if (description === null) {
		return { problem: `no usable description on the page: ${url}` };
	}
	return { description: description };
}

async function main(args: string[]) {
	// --summary anywhere means the summary form, so a misplaced flag is never fetched as a URL.
	if (args.includes("--summary")) {
		addSummary(args);
		return;
	}
	const file = args[0];
	const urls = [...new Set(args.slice(1))];
	if (!file || urls.length === 0) {
		console.error(USAGE);
		process.exit(1);
	}
	if (!existsSync(file)) {
		fail(`${file} doesn't exist`);
	}
	const decided = urlsToFetch(file, urls);

	// Fetch all pages at once.
	const answers = await Promise.all(
		decided.toFetch.map((url) => describePage(url)),
	);
	const written = addDescriptions(file, decided.toFetch, answers);
	let noun = "descriptions";
	if (written.added === 1) {
		noun = "description";
	}
	console.log(`added ${written.added} ${noun} to ${file}`);

	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (decided.failed || written.failed) {
		process.exitCode = 1;
	}
}

// Decide which pages to fetch: URLs with at least one news, article or report entry still lacking a description.
function urlsToFetch(file: string, urls: string[]) {
	let failed = false;
	const toFetch: string[] = [];
	const before = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	for (const url of urls) {
		const matches = entriesWithUrl(before.digests, url, true);
		if (matches.length === 0) {
			console.error(`describe.ts: no news, article or report entry: ${url}`);
			failed = true;
		} else if (matches.every((match) => hasDescription(match.entry))) {
			console.error(`describe.ts: already described, skipped: ${url}`);
		} else {
			toFetch.push(url);
		}
	}
	return { toFetch: toFetch, failed: failed };
}

// Put each fetched description into the entries of its URL that lack one, and write the changed lines.
function addDescriptions(
	file: string,
	toFetch: string[],
	answers: Awaited<ReturnType<typeof describePage>>[],
) {
	let failed = false;
	// Read the file again: the scout or a chat may have appended lines while the pages loaded.
	// Nothing is awaited from here to the write, so this run's own fetches can't interleave; a write by another
	// process in that same instant still could.
	const current = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	const changedLines = new Set<number>();
	let added = 0;
	for (let i = 0; i < toFetch.length; i++) {
		// Promise.all gives one answer per URL, so neither is missing; the check is for the type checker.
		const answer = answers[i];
		const url = toFetch[i];
		if (answer === undefined || url === undefined) {
			continue;
		}
		if ("problem" in answer) {
			console.error(`describe.ts: ${answer.problem}`);
			failed = true;
			continue;
		}
		for (const match of entriesWithUrl(current.digests, url, true)) {
			if (!hasDescription(match.entry)) {
				match.entry.description = answer.description;
				changedLines.add(match.index);
				added += 1;
			}
		}
	}

	// Rewrite only the lines that gained a description.
	if (changedLines.size > 0) {
		writeChangedLines(file, current, changedLines, (_real, code) =>
			fail(`couldn't write ${file}: ${code}`),
		);
	}
	return { added: added, failed: failed };
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
