// List a lab post's images; write the scout's pick.
// Usage: node scripts/scout/web/post-figure.ts <digests file> <url>
//        node scripts/scout/web/post-figure.ts <digests file> <url> --pick <n>
// Tests set LAB_PAGE_BASE: the stand-in origin.
import { existsSync } from "node:fs";
import { decodeHTMLAttribute } from "entities";
import {
	isLabFigure,
	LAB_FIGURE_ADDRESSES,
} from "../../../shared/lab-figures.ts";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import { readDigests, writeChangedLines } from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import { attribute, htmlToText, type Tag, tagsNamed } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";

const fail: Fail = failer("post-figure.ts");

const USAGE = [
	"usage: node scripts/scout/web/post-figure.ts <digests file> <url>",
	"   or: node scripts/scout/web/post-figure.ts <digests file> <url> --pick <n>",
].join("\n");
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const POST_TYPES: unknown[] = ["news", "article", "report"];
// Page furniture, not the post.
const FURNITURE = ["header", "nav", "footer", "aside"];

// One image the scout sees.
export type FigureCandidate = { src: string; alt: string; caption: string };

// An element's place in the page.
type Span = {
	start: number;
	innerStart: number;
	innerEnd: number;
	end: number;
};

// Pair opening and closing tags.
function spansOf(tags: Tag[], names: string[]): Span[] {
	const spans: Span[] = [];
	const open = new Map<string, Tag[]>();
	for (const tag of tags) {
		if (!names.includes(tag.name)) continue;
		const stack = open.get(tag.name) ?? [];
		open.set(tag.name, stack);
		if (!tag.closing) {
			stack.push(tag);
			continue;
		}
		const opening = stack.pop();
		if (opening === undefined) continue;
		spans.push({
			start: opening.start,
			innerStart: opening.end,
			innerEnd: tag.start,
			end: tag.end,
		});
	}
	return spans.sort((a, b) => a.start - b.start);
}

function inside(span: Span, at: number) {
	return at >= span.innerStart && at < span.innerEnd;
}

function paragraphText(html: string, paragraphs: Span[], span: Span) {
	let length = 0;
	for (const p of paragraphs) {
		if (p.start >= span.innerStart && p.end <= span.innerEnd) {
			length += htmlToText(html.slice(p.innerStart, p.innerEnd)).trim().length;
		}
	}
	return length;
}

// Addresses may hold commas.
function largestInSrcset(srcset: string) {
	let best = "";
	let bestSize = -1;
	for (const candidate of srcset.split(/,\s+/)) {
		const [url, descriptor] = candidate.trim().split(/\s+/);
		const size = Number.parseFloat(descriptor ?? "") || 1;
		if (url && size > bestSize) {
			best = url;
			bestSize = size;
		}
	}
	return best;
}

// Unwrap Next.js image links.
function imageAddress(raw: string, pageUrl: string) {
	const address = URL.parse(decodeHTMLAttribute(raw), pageUrl);
	if (address === null || address.protocol === "data:") return null;
	const wrapped =
		address.pathname === "/_next/image"
			? address.searchParams.get("url")
			: null;
	if (wrapped) {
		return URL.parse(wrapped, pageUrl)?.href ?? null;
	}
	return address.href;
}

function textOf(html: string) {
	return htmlToText(html).replace(/\s+/g, " ").trim();
}

// The article body's images, in order.
export function listImages(html: string, pageUrl: string): FigureCandidate[] {
	const tags = tagsNamed(html, null);
	const paragraphs = spansOf(tags, ["p"]);
	const bodies = spansOf(tags, ["article", "main"]);
	let body: Span = {
		start: 0,
		innerStart: 0,
		innerEnd: html.length,
		end: html.length,
	};
	let most = -1;
	for (const span of bodies) {
		const length = paragraphText(html, paragraphs, span);
		if (length > most) {
			body = span;
			most = length;
		}
	}
	const furniture = spansOf(tags, FURNITURE);
	const figures = spansOf(tags, ["figure"]);
	const captions = spansOf(tags, ["figcaption"]);
	const pictures = spansOf(tags, ["picture"]);
	const candidates: FigureCandidate[] = [];
	for (const tag of tags) {
		if (tag.name !== "img" || tag.closing || !inside(body, tag.start)) continue;
		if (furniture.some((span) => inside(span, tag.start))) continue;
		const width = Number(attribute(tag.text, "width"));
		const height = Number(attribute(tag.text, "height"));
		if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) continue;
		let raw = attribute(tag.text, "src");
		const srcset = attribute(tag.text, "srcset");
		const picture = pictures.find((span) => inside(span, tag.start));
		const source = picture
			? tags.find(
					(each) =>
						each.name === "source" &&
						inside(picture, each.start) &&
						attribute(each.text, "srcset"),
				)
			: undefined;
		const set = srcset || (source ? attribute(source.text, "srcset") : null);
		if (set) raw = largestInSrcset(set);
		if (!raw) continue;
		const src = imageAddress(raw, pageUrl);
		if (src === null) continue;
		const alt = textOf(decodeHTMLAttribute(attribute(tag.text, "alt") ?? ""));
		let caption = "";
		const figure = figures.find((span) => inside(span, tag.start));
		const figcaption =
			figure && captions.find((span) => inside(figure, span.start));
		if (figcaption) {
			caption = textOf(html.slice(figcaption.innerStart, figcaption.innerEnd));
		} else {
			const next = paragraphs.find((p) => p.start > tag.end);
			const text = next
				? textOf(html.slice(next.innerStart, next.innerEnd))
				: "";
			if (/^(Figure|Fig\.)\s/.test(text)) caption = text;
		}
		candidates.push({ src: src, alt: alt, caption: caption });
	}
	return candidates;
}

function findPost(file: string, url: string) {
	const read = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	for (const { index, digest } of read.digests) {
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) continue;
		for (const entry of digest.entries) {
			if (
				isJsonObject(entry) &&
				entry.url === url &&
				POST_TYPES.includes(entry.type)
			) {
				return { read: read, index: index, entry: entry };
			}
		}
	}
	return fail(`${file} has no news, article or report with the url ${url}`);
}

function fetchAddress(url: string) {
	const base = process.env.LAB_PAGE_BASE;
	if (!base) return url;
	const post = new URL(url);
	return new URL(post.pathname + post.search, base).href;
}

async function readPost(url: string) {
	const answer = await request(fetchAddress(url), {
		headers: { accept: "text/html" },
		maxBytes: MAX_PAGE_BYTES,
	});
	if ("problem" in answer) {
		return fail(`${url} not read: ${answer.problem}`);
	}
	if (!answer.ok) {
		return fail(`${url} not read: HTTP ${answer.status}`);
	}
	return listImages(answer.text(), url);
}

function printCandidates(candidates: FigureCandidate[]) {
	if (candidates.length === 0) {
		console.log("no images in the post's article body");
		return;
	}
	candidates.forEach((candidate, i) => {
		console.log(`${i + 1}. ${candidate.src}`);
		console.log(`   alt: ${candidate.alt || "(none)"}`);
		if (candidate.caption) console.log(`   caption: ${candidate.caption}`);
	});
}

function writeFigure(
	file: string,
	found: ReturnType<typeof findPost>,
	candidate: FigureCandidate,
) {
	const figure: JsonObject = { src: candidate.src, from: found.entry.url };
	if (candidate.alt) figure.alt = candidate.alt;
	if (candidate.caption) figure.caption = candidate.caption;
	found.entry.figure = figure;
	writeChangedLines(file, found.read, new Set([found.index]), (path, code) =>
		fail(`${path} not written: ${code ?? "unknown error"}`),
	);
}

async function main(args: string[]) {
	const [file, url, flag, pick] = args;
	if (
		!file ||
		!url ||
		(flag !== undefined && (flag !== "--pick" || !pick)) ||
		args.length > 4
	) {
		fail(USAGE);
	}
	if (!existsSync(file)) {
		fail(`${file} doesn't exist`);
	}
	const host = URL.parse(url)?.host ?? "";
	if (!Object.hasOwn(LAB_FIGURE_ADDRESSES, host)) {
		fail(`${url} is not from a listed lab; its page was not fetched`);
	}
	const found = findPost(file, url);
	if (found.entry.figure !== undefined) {
		console.log(`${url} already has a figure; it keeps it`);
		return;
	}
	const candidates = await readPost(url);
	if (flag === undefined) {
		printCandidates(candidates);
		return;
	}
	const n = Number(pick);
	const candidate = Number.isInteger(n) ? candidates[n - 1] : undefined;
	if (candidate === undefined) {
		fail(`no image ${pick}: the post lists ${candidates.length}`);
	}
	if (!isLabFigure(url, candidate.src)) {
		fail(
			`image ${pick} (${candidate.src}) is not from the lab's image addresses; the line is left as it was`,
		);
	}
	writeFigure(file, found, candidate);
	console.log(`figure ${pick} written for ${url}`);
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
