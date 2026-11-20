// Digest entries as Markdown, for the connector's search and get_digest (worker/src/mcp.ts) and the public per-day
// files (scripts/deploy/build-site.ts). Entry text is kept as written,
// TeX included; a line break inside a one-line field becomes a space.
import { contentsGroups } from "./entry-groups.ts";
import { isJsonObject, type JsonObject } from "./narrow.ts";
import type { EntryNotes, SiteThread, Takeaway } from "./owner-protocol.ts";

// One-line fields shown as "- <label>: <value>", in this order, when the entry has them as text.
const TEXT_FIELDS: [string, string][] = [
	["type", "Type"],
	["authors", "Authors"],
	["source", "Source"],
	["published", "Published"],
];

// A value as one line of text: every run of white space, line breaks included, becomes one space, and so does every
// C1 control character (U+0080 to U+009F): \s leaves those out, and U+0085 among them is a line break to a Markdown
// reader. Empty for a value that isn't text.
function oneLine(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	return value.replace(/[\s\u0080-\u009f]+/g, " ").trim();
}

// "<field>: <value>" for a field the entry holds as text; "<value> (<source>)" when a source is given too.
function withSource(value: unknown, source: unknown): string {
	const text = oneLine(value);
	const from = oneLine(source);
	if (from === "") {
		return text;
	}
	return `${text} (${from})`;
}

// The entry's facts, one "- <label>: <value>" line each, for those it has.
function factLines(entry: JsonObject, date: string): string[] {
	const lines: string[] = [];
	for (const [field, label] of TEXT_FIELDS) {
		let value = entry[field];
		if (Array.isArray(value)) {
			value = value.filter((item) => typeof item === "string").join(", ");
		}
		const text = oneLine(value);
		if (text !== "") {
			lines.push(`- ${label}: ${text}`);
		}
	}
	lines.push(`- Digest: ${date}`);
	lines.push(`- Id: ${oneLine(entry.id)}`);
	if (oneLine(entry.url) !== "") {
		lines.push(`- Link: ${oneLine(entry.url)}`);
	}
	// A link's label goes inside "Link (...)", never at the start of the line, so it can't pose as the marks line.
	if (Array.isArray(entry.links)) {
		for (const link of entry.links) {
			if (!isJsonObject(link) || oneLine(link.url) === "") {
				continue;
			}
			let name = "Link";
			if (oneLine(link.label) !== "") {
				name = `Link (${oneLine(link.label)})`;
			}
			lines.push(`- ${name}: ${oneLine(link.url)}`);
		}
	}
	if (oneLine(entry.venue) !== "") {
		lines.push(`- Venue: ${withSource(entry.venue, entry.venue_source)}`);
	}
	if (oneLine(entry.journal_ref) !== "") {
		lines.push(`- Journal reference: ${oneLine(entry.journal_ref)}`);
	}
	if (oneLine(entry.comment) !== "") {
		lines.push(`- arXiv comment: ${oneLine(entry.comment)}`);
	}
	if (oneLine(entry.pick) !== "") {
		lines.push(`- Pick: ${withSource(entry.pick, entry.pick_source)}`);
	}
	const figure = entry.figure;
	if (isJsonObject(figure) && oneLine(figure.src) !== "") {
		// figure.ts keeps the caption as the paper writes it, "Figure 1: ...": the label isn't repeated.
		const caption = oneLine(figure.caption).replace(/^Figure 1:\s*/, "");
		const parts = [caption, oneLine(figure.src)].filter((part) => part !== "");
		lines.push(`- Figure 1: ${parts.join(" ")}`);
	}
	return lines;
}

// The owner's marks on one line: "read: paper (2026-10-20), tags: To read, liked". Empty when there are none.
function marksLine(notes: EntryNotes): string {
	const parts: string[] = [];
	if (notes.read !== null) {
		parts.push(`read: ${notes.read.depth} (${notes.read.date})`);
	}
	if (notes.tags !== null) {
		const tags: string[] = [];
		if (notes.tags.toRead) {
			tags.push("To read");
		}
		if (notes.tags.learnFirst) {
			tags.push("Learn first");
		}
		if (tags.length > 0) {
			parts.push(`tags: ${tags.join(", ")}`);
		}
	}
	if (notes.feedback !== null) {
		if (notes.feedback.mark === "like") {
			parts.push("liked");
		} else if (notes.feedback.mark === "ok") {
			parts.push("rated OK");
		} else {
			parts.push("disliked");
		}
	}
	return parts.join(", ");
}

// One thread as Markdown list lines: where it is, then each comment "  - <day>: <text>", oldest first, or
// "  - <day> (Claude): <text>" when Claude wrote it. A highlight without comments is one line.
function threadLines(thread: SiteThread): string[] {
	let place = "the whole entry";
	if (thread.field !== null && thread.passage !== null) {
		place = `"${oneLine(thread.passage)}" (${thread.field})`;
	}
	if (thread.comments.length === 0) {
		if (thread.highlight) {
			return [`- Highlighted ${place}`];
		}
		return [];
	}
	const lines = [`- On ${place}:`];
	for (const comment of thread.comments) {
		const text = comment.text.split("\n").join("\n    ");
		let writer = "";
		if (comment.author === "claude") {
			writer = " (Claude)";
		}
		lines.push(`  - ${comment.created.slice(0, 10)}${writer}: ${text}`);
	}
	return lines;
}

// The owner's takeaways as Markdown list lines, in the order given (newest first): "- <day>: <takeaway>", then its recall
// question under it when it has one. A line break in a takeaway is indented, as in a comment.
function takeawayLines(takeaways: Takeaway[]): string[] {
	const lines: string[] = [];
	for (const takeaway of takeaways) {
		const text = takeaway.text.split("\n").join("\n    ");
		lines.push(`- ${takeaway.created.slice(0, 10)}: ${text}`);
		if (takeaway.question !== null) {
			lines.push(`  - Recall question: ${oneLine(takeaway.question)}`);
		}
	}
	return lines;
}

// Where a quoted text is split into lines: at every character a Markdown reader or a model takes for a line break,
// not only "\n". A lone "\r" (also U+0085, U+2028 and U+2029) otherwise ended the quote in what is read, and the
// text after it could pass for a heading or for the owner's notes; a stored entry can hold one (parseLine lets it in).
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

// One entry as a Markdown section headed by its title: its fields, the digest it is in, and, when `notes` is given,
// the owner's marks, comment threads and takeaways. Ends with a line break.
export function entryMarkdown(
	entry: JsonObject,
	date: string,
	notes?: EntryNotes,
): string {
	const lines = [`### ${oneLine(entry.title)}`, ""];
	lines.push(...factLines(entry, date));
	if (notes !== undefined) {
		const marks = marksLine(notes);
		if (marks !== "") {
			lines.push(`- The user's marks: ${marks}`);
		}
	}
	// The abstract, or for news, articles and reports the publisher's description, as written but quoted line by line:
	// it is the publisher's text, so a line in it can't pass for one of these (a heading, the owner's marks).
	let body = entry.abstract;
	if (typeof body !== "string" || body.trim() === "") {
		body = entry.description;
	}
	if (typeof body === "string" && body.trim() !== "") {
		lines.push("");
		for (const line of body.trim().split(LINE_BREAK)) {
			lines.push(`> ${line}`.trimEnd());
		}
	}
	if (notes !== undefined) {
		const threads: string[] = [];
		for (const thread of notes.threads) {
			threads.push(...threadLines(thread));
		}
		if (threads.length > 0) {
			lines.push("", "The user's comments:", ...threads);
		}
		if (notes.takeaways.length > 0) {
			lines.push(
				"",
				"The user's takeaways:",
				...takeawayLines(notes.takeaways),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

// "1 entry", "9 entries", "1 paper", "6 papers".
function counted(count: number, one: string, many: string) {
	if (count === 1) {
		return `1 ${one}`;
	}
	return `${count} ${many}`;
}

// The size of a text as UTF-8 bytes.
function byteLength(text: string) {
	return new TextEncoder().encode(text).length;
}

// The last line of a digest cut at `maxBytes` with `count` entries left out.
function leftOutNote(count: number, maxBytes: number) {
	const left = counted(count, "more entry was", "more entries were");
	return `\n${left} left out to keep this under ${Math.floor(maxBytes / 1024)} KB; search finds an entry by its words.\n`;
}

// One day's digest: counts, then the entries under the page's contents groups, cut at `maxBytes` when given.
export function digestMarkdown(
	date: string,
	entries: JsonObject[],
	notesById?: Map<string, EntryNotes>,
	maxBytes?: number,
): string {
	const groups = contentsGroups(entries);
	const ordered = groups.flatMap((group) =>
		group.entries.map((entry) => ({ label: group.label, entry: entry })),
	);
	const counts = groups.map(
		(group) => `${group.entries.length} ${group.label}`,
	);
	let text = `# Liminal space digest of ${date}\n\n${counted(ordered.length, "entry", "entries")}`;
	if (counts.length > 0) {
		text += `: ${counts.join(", ")}`;
	}
	text += ".\n";

	// Each entry's section, with its group's heading before the group's first entry.
	let group = "";
	for (let k = 0; k < ordered.length; k++) {
		const item = ordered[k];
		if (item === undefined) {
			continue;
		}
		const entry = item.entry;
		let section = "";
		if (item.label !== group) {
			section += `\n## ${item.label}\n`;
			group = item.label;
		}
		let notes: EntryNotes | undefined;
		if (notesById !== undefined) {
			notes = notesById.get(String(entry.id));
		}
		section += `\n${entryMarkdown(entry, date, notes)}`;
		// Past the limit, this entry and the ones after it are left out. Room stays for the note an entry after this one
		// would need, unless this is the last.
		if (maxBytes !== undefined) {
			let reserve = 0;
			if (k < ordered.length - 1) {
				reserve = byteLength(leftOutNote(ordered.length - k - 1, maxBytes));
			}
			if (byteLength(text) + byteLength(section) + reserve > maxBytes) {
				return text + leftOutNote(ordered.length - k, maxBytes);
			}
		}
		text += section;
	}
	return text;
}
