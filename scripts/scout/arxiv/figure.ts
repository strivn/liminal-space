// Record each paper's Figure 1, where arXiv publishes it in the paper's HTML version, and its caption, so the page
// can show it after the abstract. The page loads the image from arXiv; nothing is downloaded here but the HTML page,
// kept for the day in the system temp folder (html-store.ts) and read from there when first-page.ts fetched it.
// Usage: node scripts/scout/arxiv/figure.ts <digests file> <id> [<id> ...]
import { existsSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { decodeHTML, decodeHTMLAttribute } from "entities";
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import {
	type ParsedLine,
	readDigests,
	writeChangedLines,
} from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { attribute, type Tag, tagsNamed } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";
import { readStoredPage, storePage } from "./html-store.ts";

const fail: Fail = failer("figure.ts");

const USAGE =
	"usage: node scripts/scout/arxiv/figure.ts <digests file> <id> [<id> ...]";
// Where arXiv serves a paper's HTML version: <base>/<id>. Tests point it at a local stand-in.
const HTML_BASE = (process.env.ARXIV_HTML_BASE || CONSTANTS.arxivHtml).replace(
	/\/+$/,
	"",
);
// arxiv.org's robots.txt asks automated clients to wait 15 seconds between requests (Crawl-delay: 15).
const DEFAULT_DELAY_MS = CONSTANTS.crawlDelayMs;
// 10 papers are 10 requests, about 2.5 minutes at 15 s apart.
const MAX_PAPERS = 10;

// The image file extensions the page can show: PNG, JPEG, GIF, WebP and SVG.
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

// Tags are read with html.ts's tagsNamed, in one pass: the regular expressions this file used for them
// (/<figure\b(?:[^>"']|"[^"]*"|'[^']*')*>/ and its kin) rescanned the rest of the page from every tag that never
// closed, so their time grew with the square of the page.
// "Figure 1" or "Fig. 1" at the start of a caption, but not "Figure 10" or the chapter-numbered "Figure 1.2".
// "Figure 1:", "Figure 1." and "Figure 1a" still count.
const FIGURE_ONE = /^(Figure|Fig\.)\s?1(?!\d|\.\d)/;

// One <figure> element: where its opening tag starts, where its closing tag ends, where its content starts and ends,
// and the figures directly inside it.
type FigureElement = {
	start: number;
	end: number;
	innerStart: number;
	innerEnd: number;
	children: FigureElement[];
};

// A <figure> whose closing tag hasn't come yet.
type OpenFigure = {
	start: number;
	innerStart: number;
	children: FigureElement[];
};

// What figureFromHtml finds: Figure 1's image and caption, with the image's size when the tag gives both; or why not.
type FoundFigure =
	| { imageUrl: string; caption: string; width?: number; height?: number }
	| { reason: string };

// A paper entry's "figure" field, in the key order the page reads it.
type Figure = {
	src: string;
	caption: string;
	from: string;
	width?: number;
	height?: number;
};

// An answer from arXiv, or why none came.
type ArxivAnswer =
	| {
			url: string;
			finalUrl: string;
			status: number;
			ok: boolean;
			bytes: Buffer;
	  }
	| { url: string; problem: string };

// HTML -> the text a reader sees: tags removed, entities decoded. Whitespace is collapsed by the caller.
function textOf(html: string) {
	let text = "";
	let from = 0;
	for (const tag of tagsNamed(html, null)) {
		text += html.slice(from, tag.start);
		from = tag.end;
	}
	return decodeHTML(text + html.slice(from));
}

// The HTML without each stretch that starts where `open` matches and ends with the next match of `close`; an `open`
// with no `close` after it stays, as does everything after it. Both are global regular expressions that match in
// one step, so the whole reading is one pass.
function withoutBlocks(html: string, open: RegExp, close: RegExp) {
	let kept = "";
	let from = 0;
	open.lastIndex = 0;
	let start = open.exec(html);
	while (start !== null) {
		close.lastIndex = open.lastIndex;
		const end = close.exec(html);
		if (end === null) {
			break;
		}
		kept += html.slice(from, start.index);
		from = close.lastIndex;
		open.lastIndex = from;
		start = open.exec(html);
	}
	return kept + html.slice(from);
}

// What the first <figcaption> element in some HTML holds: from its opening tag to the next closing one. null when
// there is no such element.
function firstCaption(html: string) {
	const tags = tagsNamed(html, ["figcaption"]);
	const opening = tags.find((tag) => !tag.closing);
	if (opening === undefined) {
		return null;
	}
	const closing = tags.find((tag) => tag.closing && tag.start >= opening.end);
	if (closing === undefined) {
		return null;
	}
	return html.slice(opening.end, closing.start);
}

// A figcaption's HTML -> its plain text, with each formula as $<TeX>$ from LaTeXML's alttext, so the page's KaTeX
// typesets it. A formula is a <math> element (LaTeXML's MathML), from its opening tag, which carries the TeX, to the
// next closing one; a formula without alttext keeps its plain text.
function captionText(html: string) {
	let text = "";
	let from = 0;
	let opening: Tag | null = null;
	for (const tag of tagsNamed(html, ["math"])) {
		if (tag.start < from) {
			continue;
		}
		if (!tag.closing) {
			// The first opening tag since the last formula ended starts the next one.
			if (opening === null) {
				opening = tag;
			}
			continue;
		}
		if (opening === null) {
			continue; // a closing tag with no formula open
		}
		text += wordsOf(html.slice(from, opening.start));
		const tex = attribute(opening.text, "alttext");
		if (tex === null) {
			text += wordsOf(html.slice(opening.start, tag.end));
		} else {
			text += `$${decodeHTMLAttribute(tex)}$`;
		}
		from = tag.end;
		opening = null;
	}
	text += wordsOf(html.slice(from));
	return text.replace(/\s+/g, " ").trim();
}

// Caption words, a literal $ escaped as TeX writes it.
function wordsOf(html: string) {
	return textOf(html).replaceAll("$", "\\$");
}

// Every <figure> element in document order, as { start, end, innerStart, innerEnd, children }: where its opening tag
// starts, where its closing tag ends, where its content starts and ends, and the figures directly inside it.
// Figures nest when LaTeXML draws panels; a figure left unclosed is ignored.
function figureElements(html: string) {
	const figures: FigureElement[] = [];
	const open: OpenFigure[] = []; // figures whose closing tag hasn't come yet, innermost last (a stack)
	for (const tag of tagsNamed(html, ["figure"])) {
		if (!tag.closing) {
			open.push({
				start: tag.start,
				innerStart: tag.end,
				children: [],
			});
		} else {
			const opened = open.pop();
			if (opened === undefined) {
				continue; // a closing tag with no open figure
			}
			const figure: FigureElement = {
				start: opened.start,
				end: tag.end,
				innerStart: opened.innerStart,
				innerEnd: tag.start,
				children: opened.children,
			};
			const parent = open[open.length - 1];
			if (parent !== undefined) {
				parent.children.push(figure);
			}
			figures.push(figure);
		}
	}
	// A figure closes after the ones inside it, so sort back into the order their opening tags appear.
	figures.sort((a, b) => a.start - b.start);
	return figures;
}

// A figure's own content: what it holds without the figures nested in it, so a panel's caption isn't taken for
// the whole figure's.
function ownContent(html: string, figure: FigureElement) {
	let content = "";
	let from = figure.innerStart;
	for (const child of figure.children) {
		content += html.slice(from, child.start);
		from = child.end;
	}
	content += html.slice(from, figure.innerEnd);
	return content;
}

// The first image file in some HTML: an <img> with a src (not LaTeXML's placeholder for a missing image) or an SVG
// <object> with data, in document order. Returns { address, tag }: the src or data, entity-decoded, and the whole
// tag, which may carry the image's width and height. null when there is none. <img> and <object> are the two ways
// LaTeXML puts an image file in a figure.
function firstGraphic(html: string) {
	for (const found of tagsNamed(html, ["img", "object"])) {
		if (found.closing) {
			continue;
		}
		const tag = found.text;
		if (found.name === "img") {
			const src = decodeHTMLAttribute(attribute(tag, "src") || "").trim();
			const classes = (attribute(tag, "class") || "").split(/\s+/);
			if (src !== "" && !classes.includes("ltx_missing_image")) {
				return { address: src, tag: tag };
			}
		} else {
			const type = decodeHTMLAttribute(attribute(tag, "type") || "")
				.trim()
				.toLowerCase();
			const data = decodeHTMLAttribute(attribute(tag, "data") || "").trim();
			if (type === "image/svg+xml" && data !== "") {
				return { address: data, tag: tag };
			}
		}
	}
	return null;
}

// A width or height attribute as a whole number of pixels: "698" -> 698, "697.6" -> 698. null when it is missing,
// not a plain number ("432pt", "100%") or not above 0.
function sizeAttribute(tag: string, name: string) {
	const value = attribute(tag, name);
	if (value === null || !/^\d+(\.\d+)?$/.test(value.trim())) {
		return null;
	}
	const pixels = Math.round(Number(value.trim()));
	if (pixels <= 0) {
		return null;
	}
	return pixels;
}

// The extension of the file a URL names, lowercased: "https://arxiv.org/html/2609.35544v1/x1.PNG?v=2" -> "png".
// The pathname leaves out any ?query and #fragment. "" when the file name has no dot.
function extensionOf(url: URL) {
	const fileName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
	const dot = fileName.lastIndexOf(".");
	if (dot === -1) {
		return "";
	}
	return fileName.slice(dot + 1).toLowerCase();
}

// Find Figure 1 in a paper's arXiv HTML: the first <figure> whose own caption starts "Figure 1" or "Fig. 1", and the
// first image file in it. Image paths are relative ("2609.35544v1/x1.png"), so they resolve against `baseUrl`, the
// page's own URL. Returns { imageUrl, caption, width, height }, where width and height are the image tag's own
// attributes and are left out unless both are whole numbers above 0; or { reason } when there is no Figure 1 image
// the page can show.
export function figureFromHtml(html: string, baseUrl: string): FoundFigure {
	// Comments, scripts and styles are never figures, but could hold text that looks like one.
	const withoutComments = withoutBlocks(html, /<!--/g, /--!?>/g);
	const withoutScripts = withoutBlocks(
		withoutComments,
		/<script\b/gi,
		/<\/script>/gi,
	);
	const page = withoutBlocks(withoutScripts, /<style\b/gi, /<\/style>/gi);
	for (const figure of figureElements(page)) {
		const caption = firstCaption(ownContent(page, figure));
		if (caption === null) {
			continue;
		}
		const text = captionText(caption);
		if (!FIGURE_ONE.test(text)) {
			continue;
		}
		const graphic = firstGraphic(
			page.slice(figure.innerStart, figure.innerEnd),
		);
		if (graphic === null) {
			return { reason: "its Figure 1 holds no image file" };
		}
		let imageUrl: URL;
		try {
			imageUrl = new URL(graphic.address, baseUrl);
		} catch {
			return { reason: "its Figure 1 holds no image file" }; // a src no URL can be made of
		}
		// Only an image under arXiv's HTML pages is taken: the page shows no other (FIGURE_SITE), and entry-checks.ts
		// refuses one in a stored entry. A page read from a stand-in (ARXIV_HTML_BASE, tests only) may also name an
		// image under that stand-in.
		if (
			!imageUrl.href.startsWith(FIGURE_SITE) &&
			!imageUrl.href.startsWith(`${HTML_BASE}/`)
		) {
			return { reason: "its image is not under arXiv's HTML pages" };
		}
		// LaTeXML keeps some figures as files no browser shows, such as EPS or PDF.
		if (!IMAGE_EXTENSIONS.includes(extensionOf(imageUrl))) {
			return { reason: "its image isn't PNG, JPEG, GIF, WebP or SVG" };
		}
		const found: FoundFigure = { imageUrl: imageUrl.href, caption: text };
		// Both or neither: one without the other can't keep the image's proportions.
		const width = sizeAttribute(graphic.tag, "width");
		const height = sizeAttribute(graphic.tag, "height");
		if (width !== null && height !== null) {
			found.width = width;
			found.height = height;
		}
		return found;
	}
	return { reason: "it has no Figure 1" };
}

// Name what happened to one paper: "figure.ts: 2610.01716: arXiv has no HTML version of 2610.01716".
function report(id: string, message: string) {
	console.error(`figure.ts: ${id}: ${message}`);
}

// Every paper entry with this arXiv id, with the index of the line it sits on.
function paperEntries(digests: ParsedLine[], id: string) {
	const matches: { index: number; entry: JsonObject }[] = [];
	for (const item of digests) {
		if (!isJsonObject(item.digest) || !Array.isArray(item.digest.entries)) {
			continue; // a line the page can't draw either
		}
		const entries: unknown[] = item.digest.entries;
		for (const entry of entries) {
			if (
				isJsonObject(entry) &&
				entry.type === "paper" &&
				entry.id === `arxiv:${id}`
			) {
				matches.push({ index: item.index, entry: entry });
			}
		}
	}
	return matches;
}

// Where a figure the page shows comes from; the page (site/page/entry.ts) applies the same test.
const FIGURE_SITE = "https://arxiv.org/html/";

// An entry has a figure when its "figure" field is an object whose src the page would load: one under arXiv's HTML
// version. Any other value, such as an older local copy "figures/2609.35544.png", is replaced like a missing one.
function hasFigure(entry: JsonObject) {
	const figure = entry.figure;
	if (figure === null || typeof figure !== "object" || Array.isArray(figure)) {
		return false;
	}
	return (
		"src" in figure &&
		typeof figure.src === "string" &&
		figure.src.startsWith(FIGURE_SITE)
	);
}

// When the last request to arXiv ended, so the next one starts the delay after it.
let lastRequestEnded = 0;

// One GET to arXiv, at least `delayMs` after the previous request ended, with a 30 s limit.
// Returns { url, finalUrl, status, ok, bytes }, or { url, problem } when no answer came:
// "gave no answer within 30 seconds" or "could not be reached (ECONNREFUSED)".
async function arxivGet(url: string, delayMs: number): Promise<ArxivAnswer> {
	const waitMs = lastRequestEnded + delayMs - Date.now();
	if (waitMs > 0) {
		await pause(waitMs);
	}
	try {
		const answer = await request(url);
		if ("problem" in answer) {
			return { url: url, problem: answer.problem };
		}
		return {
			url: url,
			finalUrl: answer.finalUrl,
			status: answer.status,
			ok: answer.ok,
			bytes: answer.bytes,
		};
	} finally {
		lastRequestEnded = Date.now();
	}
}

// What went wrong with an answer that isn't the page asked for: "answered HTTP 503 (<url>)".
function whatHappened(answer: ArxivAnswer) {
	if ("problem" in answer) {
		return `${answer.problem} (${answer.url})`;
	}
	return `answered HTTP ${answer.status} (${answer.url})`;
}

// A paper's HTML page: the copy first-page.ts (or an earlier run) stored today, with no request and no wait; else
// one GET, whose page (200, or arXiv's 404) is stored for the day in turn.
async function fetchPage(id: string, delayMs: number): Promise<ArxivAnswer> {
	const url = `${HTML_BASE}/${id}`;
	const stored = readStoredPage(id);
	if (stored !== null) {
		return {
			url: url,
			finalUrl: stored.finalUrl,
			status: stored.status,
			ok: stored.status >= 200 && stored.status < 300,
			bytes: Buffer.from(stored.text, "utf8"),
		};
	}
	const page = await arxivGet(url, delayMs);
	if ("status" in page && (page.status === 200 || page.status === 404)) {
		storePage(id, {
			status: page.status,
			finalUrl: page.finalUrl,
			text: page.bytes.toString("utf8"),
			storedAt: new Date().toISOString(),
		});
	}
	return page;
}

// Read one paper's Figure 1 from its HTML page, the only request: the image itself is never fetched. Returns the
// entry's new "figure" field, { src, caption, from, width, height }, with width and height only when the HTML gives
// both; { reason } when the paper has no Figure 1 image the page can show, which is not a failure; or { failure }
// when arXiv didn't answer as it should.
async function fetchFigure(
	id: string,
	delayMs: number,
): Promise<{ reason: string } | { failure: string } | { figure: Figure }> {
	const page = await fetchPage(id, delayMs);
	if ("status" in page && page.status === 404) {
		return { reason: `arXiv has no HTML version of ${id}` };
	}
	if ("problem" in page || !page.ok) {
		return { failure: whatHappened(page) };
	}
	const found = figureFromHtml(page.bytes.toString("utf8"), page.finalUrl);
	if ("reason" in found) {
		return { reason: found.reason };
	}
	// Key order as the page reads it: src, caption, from, then the size when it is known.
	const figure: Figure = {
		src: found.imageUrl,
		caption: found.caption,
		from: page.finalUrl,
	};
	// figureFromHtml sets width and height together, so both are checked only for the type checker.
	if (found.width !== undefined && found.height !== undefined) {
		figure.width = found.width;
		figure.height = found.height;
	}
	return { figure: figure };
}

// FIGURE_DELAY_MS as a number of milliseconds; 15000 when unset.
function delayFromEnvironment() {
	const value = process.env.FIGURE_DELAY_MS;
	if (value === undefined || value.trim() === "") {
		return DEFAULT_DELAY_MS;
	}
	const delayMs = Number(value);
	if (Number.isNaN(delayMs) || delayMs < 0) {
		fail(
			`FIGURE_DELAY_MS must be a number of milliseconds, 0 or more, not "${value}"`,
		);
	}
	return delayMs;
}

async function main(args: string[]) {
	const file = args[0];
	if (!file || args.length < 2) {
		console.error(USAGE);
		process.exit(1);
	}
	const delayMs = delayFromEnvironment();
	if (!existsSync(file)) {
		fail(`${file} doesn't exist`);
	}

	// Normalize, and keep each id once, in the order given.
	const ids: string[] = [];
	for (const raw of args.slice(1)) {
		const id = normalizeId(raw);
		if (!ids.includes(id)) {
			ids.push(id);
		}
	}
	const decided = papersToFetch(file, ids);
	const thisRun = decided.wanted.slice(0, MAX_PAPERS);
	const nextRun = decided.wanted.slice(MAX_PAPERS);
	const fetched = await fetchFigures(thisRun, delayMs);
	const added = addFigures(file, fetched.figures);
	let noun = "figures";
	if (added === 1) {
		noun = "figure";
	}
	console.log(`added ${added} ${noun} to ${file}`);
	if (nextRun.length > 0) {
		console.log(
			`not done in this run (at most ${MAX_PAPERS} a run): ${nextRun.join(", ")}; run the same command again for them`,
		);
	}

	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (decided.failed || fetched.failed) {
		process.exitCode = 1;
	}
}

// Decide which papers to fetch, before any request: a paper entry still without a figure; the others are named.
function papersToFetch(file: string, ids: string[]) {
	let failed = false;
	const wanted: string[] = [];
	const before = readDigests(file, (line) =>
		fail(`line ${line} of ${file} doesn't load`),
	);
	for (const id of ids) {
		if (!isArxivId(id)) {
			report(id || '""', "not an arXiv id"); // an empty argument would print as nothing
			failed = true;
			continue;
		}
		const papers = paperEntries(before.digests, id);
		if (papers.length === 0) {
			report(id, `no paper entry for ${id}`);
			failed = true;
		} else if (papers.every((paper) => hasFigure(paper.entry))) {
			report(id, "already has a figure");
		} else {
			wanted.push(id);
		}
	}
	return { wanted: wanted, failed: failed };
}

// Read one paper's HTML at a time; arxivGet spaces the requests.
async function fetchFigures(ids: string[], delayMs: number) {
	let failed = false;
	const figures = new Map<string, Figure>(); // id -> the entry's new "figure" field
	for (const id of ids) {
		// biome-ignore lint/performance/noAwaitInLoops: arXiv's crawl delay: arxivGet spaces the requests 15 s apart
		const result = await fetchFigure(id, delayMs);
		if ("failure" in result) {
			report(id, result.failure);
			failed = true;
			continue;
		}
		if ("reason" in result) {
			report(id, result.reason);
			continue;
		}
		figures.set(id, result.figure);
	}
	return { figures: figures, failed: failed };
}

// Put each figure into the entries of its paper that lack one, and write the changed lines; returns how many were added.
function addFigures(file: string, figures: Map<string, Figure>) {
	// Read the file again: the scout or a chat may have appended lines during the minutes the requests took.
	// Nothing is awaited from here to the write, so this run can't interleave with itself.
	const current = readDigests(file, (line) =>
		fail(`line ${line} of ${file} doesn't load`),
	);
	const changedLines = new Set<number>();
	let added = 0;
	for (const id of figures.keys()) {
		for (const paper of paperEntries(current.digests, id)) {
			if (!hasFigure(paper.entry)) {
				paper.entry.figure = figures.get(id);
				changedLines.add(paper.index);
				added += 1;
			}
		}
	}

	// Rewrite only the lines that gained a figure; every other line keeps its exact bytes. Through a symlink, the
	// file it points to is replaced and the link stays a link.
	if (changedLines.size > 0) {
		writeChangedLines(file, current, changedLines, (real, code) =>
			fail(`couldn't write ${real}: ${code}`),
		);
	}
	return added;
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
