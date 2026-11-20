// Reading interests.md's sections and building the arXiv and Google News queries from its phrases.
import { splitParts } from "./title-match.ts";

// One topic of interests.md's "Search phrases" section: its number and its phrases.
export type Topic = { topic: number; phrases: string[] };
// One accepted-paper list of interests.md's "Conferences" section.
export type ConferenceList = {
	venue: string;
	url: string;
	published: string | null;
};

// The lines of the Markdown section headed "## <name>", up to the next "## " heading; null when there is no such section.
function sectionLines(markdown: string, name: string) {
	const lines = markdown.split(/\r?\n/);
	const heading = lines.findIndex((line) => line.trim() === `## ${name}`);
	if (heading === -1) {
		return null;
	}
	const section: string[] = [];
	for (const line of lines.slice(heading + 1)) {
		if (line.startsWith("## ")) {
			break;
		}
		section.push(line);
	}
	return section;
}

// interests.md's "Search phrases" section -> [{ topic: 1, phrases: ['sparse autoencoder', ...] }], in file order; null
// when there is no such section.
export function searchPhrases(markdown: string): Topic[] | null {
	return phraseSection(markdown, "Search phrases");
}

// interests.md's "News phrases" section -> [{ topic: 6, phrases: ['differential privacy', 'AI & privacy'] }], written as
// "Search phrases" is; null when there is no such section.
export function newsPhrases(markdown: string): Topic[] | null {
	return phraseSection(markdown, "News phrases");
}

// A section of topic lines, in file order; null when there is no such section. A topic line is "<n>. <phrase>, <phrase>,
// ..."; other lines are prose and ignored. A topic line without phrases is named on stderr and left out.
function phraseSection(markdown: string, name: string): Topic[] | null {
	const lines = sectionLines(markdown, name);
	if (lines === null) {
		return null;
	}
	const topics = [];
	for (const line of lines) {
		// "1. sparse autoencoder, activation steering" -> "1" and " sparse autoencoder, activation steering"
		const match = line.trim().match(/^(\d+)\.(\s.*)?$/);
		if (match === null) {
			continue;
		}
		const topic = Number(match[1]);
		const phrases = splitParts(match[2] || "", ",");
		if (phrases.length === 0) {
			console.error(`search.ts: topic ${topic} has no phrases in ${name}`);
			continue;
		}
		topics.push({ topic: topic, phrases: phrases });
	}
	return topics;
}

// interests.md's "Conferences" section -> [{ venue, url, published }], one per "- <venue>: <url>" line in file order,
// published being the date of a trailing "(published YYYY-MM-DD)", else null. Several lines may share a venue. A list
// line whose address isn't http(s) is named on stderr and left out; lines that aren't list lines are prose.
export function conferenceLists(markdown: string): ConferenceList[] {
	const lists: ConferenceList[] = [];
	const lines = sectionLines(markdown, "Conferences");
	if (lines === null) {
		return lists;
	}
	for (const raw of lines) {
		const line = raw.trim();
		if (!line.startsWith("- ")) {
			continue;
		}
		// "- AIES: https://... (published 2026-10-01)" -> "AIES", "https://...", " (published 2026-10-01)"
		const match = line.match(/^- ([^:]+):\s+(\S+)(.*)$/);
		let venue = "";
		let url = "";
		let rest = "";
		if (match !== null) {
			venue = match[1] || "";
			url = match[2] || "";
			rest = match[3] || "";
		}
		// URL.canParse follows the browser's URL rules, under which an http or https address with no host doesn't parse.
		const isWebAddress =
			(url.startsWith("http://") || url.startsWith("https://")) &&
			URL.canParse(url);
		if (!isWebAddress) {
			console.error(`search.ts: not a web address in Conferences: ${line}`);
			continue;
		}
		let published: string | null = null;
		const date = rest.match(/\(published (\d{4}-\d{2}-\d{2})\)/);
		if (date !== null) {
			published = date[1] || null;
		}
		lists.push({ venue: venue.trim(), url: url, published: published });
	}
	return lists;
}

// Each phrase as one search clause: its parts written by `quote`, a single part alone, several joined with `and` in
// parentheses.
function phraseClauses(
	phrases: string[],
	quote: (part: string) => string,
	and: string,
) {
	return phrases.map((phrase) => {
		const parts = splitParts(phrase, "&").map(quote);
		if (parts.length === 1) {
			return parts[0];
		}
		return `(${parts.join(and)})`;
	});
}

// Phrases as arXiv abstract searches joined with OR: abs:"A" OR (abs:"B" AND abs:"C"). A phrase is searched in
// abstracts as written; "A & B" asks for an abstract holding both.
export function phrasesQuery(phrases: string[]): string {
	return phraseClauses(phrases, (part) => `abs:"${part}"`, " AND ").join(
		" OR ",
	);
}

// One topic's arXiv query: its phrases joined with OR, inside the submission-date window from `start` to `end`
// (YYYYMMDD).
export function topicQuery(
	phrases: string[],
	start: string,
	end: string,
): string {
	return `submittedDate:[${start}0000 TO ${end}2359] AND (${phrasesQuery(phrases)})`;
}

// One topic's Google News queries: its phrases without "&" quoted and joined with OR, then each "A & B" phrase alone
// as "A" "B". Google News ignores parentheses and reads OR before the space between words, so an "A & B" phrase in the
// OR list would ask for B with every other phrase.
export function newsQueries(phrases: string[]): string[] {
	const queries = [];
	const plain = phrases.filter(
		(phrase) => splitParts(phrase, "&").length === 1,
	);
	if (plain.length > 0) {
		queries.push(
			`(${phraseClauses(plain, (part) => `"${part}"`, " ").join(" OR ")})`,
		);
	}
	for (const phrase of phrases) {
		const parts = splitParts(phrase, "&");
		if (parts.length > 1) {
			queries.push(parts.map((part) => `"${part}"`).join(" "));
		}
	}
	return queries;
}

// A text cut to n characters: its first n-1 then "…", so the result is n long. A text that fits stays as it is.
export function cut(text: string, n: number): string {
	// Counted in code points, so a character outside the Basic Multilingual Plane (an emoji) is never split in half.
	const characters = Array.from(text);
	if (characters.length <= n) {
		return text;
	}
	return `${characters.slice(0, n - 1).join("")}…`;
}
