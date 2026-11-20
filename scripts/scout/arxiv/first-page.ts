// The start of each arXiv paper, for the scout to read its authors' affiliations. Stores nothing but the day's copy
// of each HTML page it fetched, in the system temp folder for figure.ts (html-store.ts).
// Usage: node scripts/scout/arxiv/first-page.ts <arxiv-id> [<arxiv-id> ...]
// For each paper: arXiv's HTML version when it marks an affiliation, else page 1 of the PDF, read through HTTP range
// requests (4.2 of 56.9 MB downloaded on 10 papers).
// Standard output, per paper: "== arxiv:<id> (from HTML) ==" or "== arxiv:<id> (from PDF) ==", the text, a blank line.
import { setTimeout as pause } from "node:timers/promises";
import { decodeHTML } from "entities";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import {
	getDocument,
	PDFDataRangeTransport,
} from "pdfjs-dist/legacy/build/pdf.mjs";
// pdf.js's package exports this type only from its own source tree.
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api.js";
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { errorCode } from "../../../shared/narrow.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { request } from "../../lib/http.ts";
import { readStoredPage, storePage } from "./html-store.ts";

const USAGE =
	"usage: node scripts/scout/arxiv/first-page.ts <arxiv-id> [<arxiv-id> ...]";
// HTML from arxiv.org, whose robots.txt allows /html with Crawl-delay 15; export.arxiv.org's disallows every path.
const HTML_BASE = (process.env.ARXIV_HTML_BASE || CONSTANTS.arxivHtml).replace(
	/\/+$/,
	"",
);
// PDFs from export.arxiv.org, the host arXiv's bulk-data page sets aside for programmatic access.
const PDF_BASE = (process.env.ARXIV_PDF_BASE || CONSTANTS.arxivPdf).replace(
	/\/+$/,
	"",
);
const HTML_DELAY_MS = Number(
	process.env.FIRST_PAGE_HTML_DELAY_MS || CONSTANTS.crawlDelayMs,
);
// The bulk-data page asks for bursts of at most 4 requests with a 1 second sleep between bursts.
const BURST_SIZE = CONSTANTS.burstSize;
const BURST_DELAY_MS = Number(
	process.env.FIRST_PAGE_BURST_DELAY_MS || CONSTANTS.burstDelayMs,
);
// pdf.js asks for the file in chunks of this many bytes; the first request asks for one chunk.
const CHUNK_BYTES = 65536;

// The author block ends at the dates, the abstract or the first section.
const AUTHORS_BLOCK =
	/<div class="ltx_authors">([\s\S]*?)<\/div>\s*(?:<div[^>]*class="ltx_(?:dates|abstract)|<section)/;
const TITLE = /<h1 class="ltx_title ltx_title_document">([\s\S]*?)<\/h1>/;
// LaTeXML labels each affiliation with a nested <span class="ltx_contact_name">Affiliation: </span>; it is removed
// first (LABEL), so the affiliation's own text runs to the next </span>.
const LABEL = /<span class="ltx_contact_name">[\s\S]*?<\/span>/g;
const AFFILIATION =
	/class="[^"]*\bltx_role_affiliation\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
const TAG = /<[^>]+>/g;

// When the last HTML request ended, and the state of the current burst of PDF requests.
let lastHtmlEnd = 0;
let burstCount = 0;
let burstEnd = 0;

// Visible text of an HTML fragment: tags dropped, entities decoded, runs of spaces made one.
function textOf(html: string) {
	return decodeHTML(html.replace(TAG, " "))
		.replace(/[ \t\r\n]+/g, " ")
		.trim();
}

// One GET with the shared user agent and time limit. Returns the answer, or throws with a readable reason.
async function get(url: string, headers: Record<string, string> = {}) {
	const answer = await request(url, { headers: headers });
	if (!("problem" in answer)) {
		return answer;
	}
	const error = answer.error;
	if (error instanceof Error && error.name === "TimeoutError") {
		throw new Error(
			`could not fetch ${url}: no answer within ${CONSTANTS.requestTimeoutMs / 1000} seconds`,
		);
	}
	// fetch hides the network's reason (ENOTFOUND, ECONNREFUSED) in error.cause.
	let reason: string | undefined;
	if (error instanceof Error) {
		reason = error.message;
		const code = errorCode(error.cause);
		if (code) {
			reason = code;
		}
	}
	throw new Error(`could not fetch ${url}: ${reason}`);
}

// The title, authors and affiliations from arXiv's HTML version, or null when it marks no affiliation with text.
// The page (or arXiv's 404) is kept for figure.ts (html-store.ts); a copy stored today is read instead of
// fetched, without the wait.
async function fromHtml(id: string) {
	let html: string;
	const stored = readStoredPage(id);
	if (stored !== null) {
		if (stored.status !== 200) {
			return null;
		}
		html = stored.text;
	} else {
		const wait = lastHtmlEnd + HTML_DELAY_MS - Date.now();
		if (lastHtmlEnd > 0 && wait > 0) {
			await pause(wait);
		}
		try {
			const response = await get(`${HTML_BASE}/${id}`);
			html = response.text();
			// The two answers the store is for, as figure.ts keeps them: the page, or arXiv's "no HTML version".
			if (response.status === 200 || response.status === 404) {
				storePage(id, {
					status: response.status,
					finalUrl: response.finalUrl,
					text: html,
					storedAt: new Date().toISOString(),
				});
			}
			if (!response.ok) {
				return null;
			}
		} catch {
			// No HTML is not a failure: the PDF is read instead.
			return null;
		} finally {
			lastHtmlEnd = Date.now();
		}
	}
	html = html.replace(LABEL, " ");
	const affiliations: string[] = [];
	for (const match of html.matchAll(AFFILIATION)) {
		// A label written straight into the span, without its own ltx_contact_name, is not an affiliation either.
		const text = textOf(match[1] || "").replace(/^Affiliation:\s*/i, "");
		if (text !== "") {
			affiliations.push(text);
		}
	}
	if (affiliations.length === 0) {
		return null;
	}
	const lines: string[] = [];
	const title = html.match(TITLE);
	if (title) {
		lines.push(textOf(title[1] || ""));
	}
	const authors = html.match(AUTHORS_BLOCK);
	if (authors) {
		lines.push(textOf(authors[1] || ""));
	} else {
		lines.push(affiliations.join("; "));
	}
	return lines.join("\n");
}

// One range request for bytes [begin, end), waiting first when the current burst already holds BURST_SIZE requests.
// Returns { status, total, bytes }: a server that ignores Range answers 200 with the whole file.
async function rangeRequest(url: string, begin: number, end: number) {
	// A pause of BURST_DELAY_MS since the last request ended starts a new burst.
	if (Date.now() - burstEnd >= BURST_DELAY_MS) {
		burstCount = 0;
	}
	if (burstCount >= BURST_SIZE) {
		await pause(burstEnd + BURST_DELAY_MS - Date.now());
		burstCount = 0;
	}
	burstCount += 1;
	try {
		const response = await get(url, { range: `bytes=${begin}-${end - 1}` });
		if (response.status !== 206 && response.status !== 200) {
			throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
		}
		const bytes = new Uint8Array(response.bytes);
		// "bytes 0-65535/421437": the number after the slash is the file's size.
		let total = bytes.length;
		const range = response.headers.get("content-range");
		if (response.status === 206 && range) {
			total = Number(range.split("/")[1]);
		}
		return { status: response.status, total: total, bytes: bytes };
	} finally {
		burstEnd = Date.now();
	}
}

// The text of page 1 of the paper's PDF, fetching only the byte ranges pdf.js asks for, one request at a time.
async function fromPdf(id: string) {
	const url = `${PDF_BASE}/${id}`;
	const first = await rangeRequest(url, 0, CHUNK_BYTES);
	// A range request that fails rejects this promise, so the read below stops instead of waiting for pdf.js forever.
	let rangeFailed: (reason: unknown) => void;
	const failure = new Promise<never>((_resolve, reject) => {
		rangeFailed = reject;
	});
	let source: DocumentInitParameters;
	if (first.status === 200 || first.total <= first.bytes.length) {
		// The whole file came back (a server that ignores Range, or a file smaller than one chunk).
		source = { data: first.bytes };
	} else {
		const transport = new PDFDataRangeTransport(first.total, first.bytes);
		// pdf.js may ask for several ranges at once; a chain of promises sends them one after another.
		let queue = Promise.resolve();
		transport.requestDataRange = (begin, end) => {
			queue = queue
				.then(async () => {
					const part = await rangeRequest(url, begin, end);
					transport.onDataRange(begin, part.bytes);
				})
				.catch(rangeFailed);
		};
		source = {
			range: transport,
			disableAutoFetch: true,
			disableStream: true,
			rangeChunkSize: CHUNK_BYTES,
		};
	}
	const task = getDocument(Object.assign(source, { verbosity: 0 }));
	// Whichever comes first: page 1's text, or the first failed range request.
	try {
		return await Promise.race([pageOneText(task), failure]);
	} finally {
		await task.destroy();
	}
}

// Page 1's text from a pdf.js loading task, one line per line of the page.
async function pageOneText(task: PDFDocumentLoadingTask) {
	const doc = await task.promise;
	const page = await doc.getPage(1);
	const content = await page.getTextContent();
	let text = "";
	for (const item of content.items) {
		// Marked-content items come only with includeMarkedContent, which this call leaves off.
		if (!("str" in item)) {
			continue;
		}
		text += item.str;
		if (item.hasEOL) {
			text += "\n";
		} else {
			text += " ";
		}
	}
	return text.trim();
}

async function main(args: string[]) {
	if (args.length === 0) {
		console.error(`first-page.ts: needs at least one arXiv id\n${USAGE}`);
		process.exit(1);
	}
	let failed = false;
	for (const arg of args) {
		const id = normalizeId(arg);
		if (!isArxivId(id)) {
			console.error(`first-page.ts: "${arg}" is not an arXiv id`);
			failed = true;
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: arXiv's crawl delay: one paper at a time, 15 s apart
		const html = await fromHtml(id);
		if (html !== null) {
			console.log(`== arxiv:${id} (from HTML) ==\n${html}\n`);
			continue;
		}
		try {
			console.log(`== arxiv:${id} (from PDF) ==\n${await fromPdf(id)}\n`);
		} catch (error) {
			let message: string | undefined;
			if (error instanceof Error) {
				message = error.message;
			}
			console.error(`first-page.ts: arxiv:${id}: ${message}`);
			failed = true;
		}
	}
	if (failed) {
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
