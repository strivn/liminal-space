// Text the page builds from an entry: the Copy reference, Discuss's text and link, the contents groups and links in text.
import { ADDED_TYPES } from "../../shared/entry-checks.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import type { Entry } from "./types.ts";

export { contentsGroups, entryGroup } from "../../shared/entry-groups.ts";

// An entry's id as its meta line shows it: a web page's "url:" id as the page's site without "www.", every other id
// whole. Copy and the chat keep the whole id; the meta line only names where the page is.
export function shownId(id: string): string {
	if (!id.startsWith("url:") || !URL.canParse(id.slice(4))) return id;
	return new URL(id.slice(4)).hostname.replace(/^www\./, "");
}

// The entry's meta line.
export function metaLine(entry: Entry): string {
	const parts = [entry.type, entry.source];
	if (ADDED_TYPES.includes(entry.type)) {
		const host = linkHost(entry);
		if (host !== String(entry.source ?? "").toLowerCase()) {
			parts.push(host);
		}
	} else {
		parts.push(shownId(entry.id));
	}
	return parts.filter(Boolean).join(" · ");
}

// Link host, else the id's.
function linkHost(entry: Entry): string {
	if (typeof entry.url === "string" && URL.canParse(entry.url)) {
		return new URL(entry.url).hostname.replace(/^www\./, "");
	}
	return shownId(entry.id);
}

// What the Copy button puts on the clipboard: one line with labelled fields, so a lost newline can't merge them.
export function referenceText(entry: Entry): string {
	return `${entry.title}; ID/DOI: ${entry.id}; URL: ${entry.url}`;
}

// Only http(s) links: entries are copied from web pages, so a javascript: URL must never become a link.
// The URL comes back as text, which is how every caller uses it (an href, or new URL()).
export function safeUrl(url: unknown): string | null {
	// The test reads any value as text.
	const text = String(url || "");
	if (/^https?:\/\//i.test(text)) return text;
	return null;
}

// A piece of text cut at its web addresses and DOIs: plain text pieces have no href; link pieces have the text as
// written and where it goes. Joining every piece's text gives the input back unchanged.
export type TextPiece = { text: string; href?: string };

// A web address runs from "http://" or "https://" to the next space; a DOI follows "DOI: " or "doi:" (any case).
const LINK_PATTERN = /(https?:\/\/\S+)|\b(doi: *)(10\.\d{4,9}\/\S+)/gi;
// What ends a sentence, a clause or a quotation rather than an address, when it is an address's last character.
const TRAILING_PUNCTUATION = ".,;:!?\"'";

// How many times `character` appears in `text`.
function countOf(text: string, character: string) {
	return text.split(character).length - 1;
}

// An address or DOI as found, less what belongs to the sentence around it: a trailing ".", ",", ";", ":", "!", "?",
// '"' or "'", and a trailing ")", "]" or ">" that has no opening partner inside it, as in "(see https://example.com/x)"
// or "<https://example.com/x>".
function trimAddress(found: string): string {
	let text = found;
	while (text.length > 0) {
		const last = text.charAt(text.length - 1);
		const sentenceEnd = TRAILING_PUNCTUATION.includes(last);
		const unmatchedParen =
			last === ")" && countOf(text, "(") < countOf(text, ")");
		const unmatchedBracket =
			last === "]" && countOf(text, "[") < countOf(text, "]");
		const unmatchedAngle =
			last === ">" && countOf(text, "<") < countOf(text, ">");
		if (!sentenceEnd && !unmatchedParen && !unmatchedBracket && !unmatchedAngle)
			break;
		text = text.slice(0, -1);
	}
	return text;
}

// TeX delimiters in paper titles and abstracts. "$" comes after "$$", as KaTeX's docs require.
export type MathDelimiter = { left: string; right: string; display: boolean };
export const MATH_DELIMITERS: MathDelimiter[] = [
	{ left: "$$", right: "$$", display: true },
	{ left: "$", right: "$", display: false },
	{ left: "\\(", right: "\\)", display: false },
	{ left: "\\[", right: "\\]", display: true },
];

// A character TeX escapes in prose, such as \$ or \%.
export type Literal = { literal: string };

// Cut `text` at each escaped \$ \% \& \# \_ outside delimited math. Math stays whole.
export function literalPieces(text: string): (string | Literal)[] {
	const pieces: (string | Literal)[] = [];
	const unclosed = new Set<string>();
	let plain = "";
	for (let i = 0; i < text.length; ) {
		const escaped = /^\\([$%&#_])/.exec(text.slice(i, i + 2));
		if (escaped !== null) {
			if (plain !== "") pieces.push(plain);
			pieces.push({ literal: escaped[1] as string });
			plain = "";
			i += 2;
			continue;
		}
		const after = mathEnd(text, i, unclosed);
		if (after !== -1) {
			plain += text.slice(i, after);
			i = after;
			continue;
		}
		plain += text[i];
		i++;
	}
	if (plain !== "") pieces.push(plain);
	return pieces;
}

// Where the math opening at `i` ends, or -1. A delimiter `unclosed` holds never closes later.
function mathEnd(text: string, i: number, unclosed: Set<string>): number {
	const math = MATH_DELIMITERS.find((delimiter) =>
		text.startsWith(delimiter.left, i),
	);
	if (math === undefined || unclosed.has(math.left)) return -1;
	const end = closingDelimiter(text, math.right, i + math.left.length);
	if (end === -1) {
		unclosed.add(math.left);
		return -1;
	}
	return end + math.right.length;
}

// Where `right` closes math, an escaped \$ not counting.
function closingDelimiter(text: string, right: string, from: number): number {
	let end = text.indexOf(right, from);
	while (end > 0 && right === "$" && text[end - 1] === "\\") {
		end = text.indexOf(right, end + 1);
	}
	return end;
}

// An abstract is plain text, so a % in its math is a percent sign, never the start of a TeX comment.
export function escapePercent(math: string): string {
	return math.replace(/(?<!\\)%/g, "\\%");
}

// A prose command's element and what it holds, which is more prose, or for texttt one piece of text.
export type ProseElement = {
	tag: "i" | "em" | "strong" | "code" | "span";
	class?: string;
	children: ProseNode[];
};
export type ProseNode = string | ProseElement;

const PROSE_ELEMENTS: Record<string, Omit<ProseElement, "children">> = {
	textit: { tag: "i" },
	emph: { tag: "em" },
	textbf: { tag: "strong" },
	texttt: { tag: "code" },
	textsc: { tag: "span", class: "small-caps" },
};

// Cut `text` at its known prose commands (\textit, \emph, \textbf, \texttt, \textsc): each becomes an element holding its
// braces' content. Math, unknown commands and groups without their closing brace stay as written.
export function proseNodes(text: string, depth: number): ProseNode[] {
	if (depth >= 32) return [text];
	const nodes: ProseNode[] = [];
	const unclosed = new Set<string>();
	let plain = "";
	for (let i = 0; i < text.length; ) {
		// Delimited formulas stay untouched, whether or not KaTeX is there to draw them.
		const after = mathEnd(text, i, unclosed);
		if (after !== -1) {
			plain += text.slice(i, after);
			i = after;
			continue;
		}
		if (text[i] !== "\\") {
			plain += text[i];
			i++;
			continue;
		}
		const command = /^\\([a-zA-Z]+)\s*\{/.exec(text.slice(i));
		if (command === null) {
			plain += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		const from = i + command[0].length;
		let end = from;
		let braces = 1;
		while (end < text.length && braces > 0) {
			if (text[end] === "\\") {
				end += 2;
				continue;
			}
			if (text[end] === "{") braces++;
			if (text[end] === "}") braces--;
			end++;
		}
		const element = PROSE_ELEMENTS[command[1] || ""];
		if (braces !== 0 || element === undefined) {
			plain += text.slice(i, end);
			i = end;
			continue;
		}
		if (plain !== "") nodes.push(plain);
		plain = "";
		const content = text.slice(from, end - 1);
		if (element.tag === "code") nodes.push({ ...element, children: [content] });
		else nodes.push({ ...element, children: proseNodes(content, depth + 1) });
		i = end;
	}
	if (plain !== "") nodes.push(plain);
	return nodes;
}

// Cut `text` at each \href{address}{words} and \url{address} the authors wrote, alone or as the whole of a $...$ or
// $$...$$ span: a web address becomes a piece with its words and href, any other address leaves only its words, and a
// command without both closing braces stays as written.
export function texLinkPieces(text: string): TextPiece[] {
	const pieces: TextPiece[] = [];
	let plainStart = 0; // where the text not yet in a piece starts
	let from = 0; // where the search for the next command goes on
	for (;;) {
		const found = /\\(href|url)\{/.exec(text.slice(from));
		if (found === null) break;
		const start = from + found.index;
		const command = texLinkAt(text, start, found[1] === "href");
		if (command === null) {
			from = start + found[0].length;
			continue;
		}
		// A command that is the whole of a $...$ or $$...$$ span takes its dollar signs with it.
		let cutFrom = start;
		let cutTo = command.end;
		const doubled =
			text.startsWith("$$", start - 2) && text.startsWith("$$", cutTo);
		const single =
			text[start - 1] === "$" &&
			text[start - 2] !== "$" &&
			text[cutTo] === "$" &&
			text[cutTo + 1] !== "$";
		if (doubled) {
			cutFrom -= 2;
			cutTo += 2;
		} else if (single) {
			cutFrom--;
			cutTo++;
		}
		if (cutFrom > plainStart)
			pieces.push({ text: text.slice(plainStart, cutFrom) });
		const href = safeUrl(command.address);
		if (href === null) pieces.push({ text: command.words });
		else pieces.push({ text: command.words, href: href });
		plainStart = cutTo;
		from = cutTo;
	}
	if (plainStart < text.length) pieces.push({ text: text.slice(plainStart) });
	return pieces;
}

// The \href{address}{words} or \url{address} that starts at `start`: its address as TeX reads it (a backslash before
// one of #$%&~_^{} stands for that character, as in KaTeX), its words (a \url's words are its address) and where it
// ends. Null when a closing brace is missing.
function texLinkAt(
	text: string,
	start: number,
	hasWords: boolean,
): { address: string; words: string; end: number } | null {
	const first = braceGroup(text, text.indexOf("{", start));
	if (first === null) return null;
	const address = first.content.replace(/\\([#$%&~_^{}])/g, "$1");
	if (!hasWords) return { address: address, words: address, end: first.end };
	if (text[first.end] !== "{") return null;
	const second = braceGroup(text, first.end);
	if (second === null) return null;
	return { address: address, words: second.content, end: second.end };
}

// The content of the brace group that opens at `open`, and the index after its closing brace. Null when it never
// closes. A backslash keeps the next character from counting as a brace.
function braceGroup(
	text: string,
	open: number,
): { content: string; end: number } | null {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return { content: text.slice(open + 1, i), end: i + 1 };
		}
	}
	return null;
}

export function linkPieces(text: string): TextPiece[] {
	const pieces: TextPiece[] = [];
	let plainStart = 0; // where the text not yet in a piece starts
	for (const match of text.matchAll(LINK_PATTERN)) {
		const address = match[1];
		const doiPrefix = match[2];
		const doi = match[3];
		let start = match.index;
		let shown = "";
		let href = "";
		if (address !== undefined) {
			shown = trimAddress(address);
			href = shown;
			// "https://" with nothing after it isn't an address.
			if (!/^https?:\/\/./i.test(shown)) continue;
		} else if (doiPrefix !== undefined && doi !== undefined) {
			// The link is on the DOI itself; "DOI: " before it stays text.
			start += doiPrefix.length;
			shown = trimAddress(doi);
			href = `https://doi.org/${shown}`;
			if (!/^10\.\d{4,9}\/./.test(shown)) continue;
		}
		if (start > plainStart)
			pieces.push({ text: text.slice(plainStart, start) });
		pieces.push({ text: shown, href: href });
		plainStart = start + shown.length;
	}
	if (plainStart < text.length) pieces.push({ text: text.slice(plainStart) });
	return pieces;
}

// What each kind of entry is called in the chat's prompt: "this paper", "this news item".
const ENTRY_NAMES: Record<string, string> = {
	paper: "paper",
	news: "news item",
	article: "article",
	report: "report",
};

// What Discuss types into the new chat: Copy's reference, a blank line, and the prompt for this kind of entry, which
// asks the chat to read it in full, to look it up through the connector when it has one, and to end with the owner's
// takeaway saved through propose_takeaway.
export function discussText(entry: Entry): string {
	const name = ENTRY_NAMES[entry.type] || "entry";
	return (
		`${referenceText(entry)}\n\n` +
		`I want to discuss this ${name}. Read it first in full. If the liminal space connector is available, look this ` +
		`${name} up there too, to see my comments and takeaways on it. When we're done, ask me for my takeaway in my own ` +
		"words, point out what the discussion settled that my sentence misses, draft one question whose answer " +
		"is my takeaway, and save both with propose_takeaway after I agree."
	);
}

// Discuss opens a new claude.ai chat with its text typed in, not sent: on the web, and in the Claude app on a phone
// that has it.
export function discussLink(entry: Entry): string {
	return `https://claude.ai/new?q=${encodeURIComponent(discussText(entry))}`;
}

// Talk about it opens a new ChatGPT chat with Discuss's text typed in, not sent. ChatGPT can use the connector, so the
// prompt's propose_takeaway works there too.
export function talkLink(entry: Entry): string {
	return `https://chatgpt.com/?q=${encodeURIComponent(discussText(entry))}`;
}

// A paper's line above its title once it has a published version: "paper · <venue> · <DOI or site> · arXiv <id>";
// null without one.
export function publishedLine(entry: Entry): string | null {
	if (entry.type !== "paper") return null;
	const cameraReady = isJsonObject(entry.camera_ready)
		? entry.camera_ready
		: null;
	const ownPage = entry.id.startsWith("doi:") || entry.id.startsWith("url:");
	const address = [cameraReady?.url, ownPage ? entry.url : null].find(
		(url) => typeof url === "string" && url.startsWith("https://"),
	);
	if (typeof address !== "string" || !URL.canParse(address)) return null;
	const venue = [cameraReady?.venue, entry.venue, entry.source].find(
		(name) => typeof name === "string" && name !== "",
	);
	let doi: unknown = cameraReady?.doi;
	if (typeof doi !== "string" && entry.id.startsWith("doi:"))
		doi = entry.id.slice("doi:".length);
	const where =
		typeof doi === "string"
			? `doi:${doi}`
			: new URL(address).hostname.replace(/^www\./, "");
	const arxiv = entry.id.startsWith("arxiv:")
		? `arXiv ${entry.id.slice("arxiv:".length)}`
		: null;
	return [entry.type, venue, where, arxiv].filter(Boolean).join(" · ");
}
