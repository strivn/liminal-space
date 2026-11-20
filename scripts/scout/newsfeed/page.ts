// The newsfeed's reader for a lab's blog page that has no feed: each dated link to a post becomes an item.
import { cutAtWord } from "../../../shared/entry-checks.ts";
import { attribute, tagsNamed } from "../../lib/html.ts";
import { type Item, markupToText, ReadProblem } from "./item.ts";

// The most characters of a post's title that are kept.
const TITLE_MAX = 200;
const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];
// A date as a page writes it: "Nov 13, 2026", "November 17, 2026".
const WRITTEN_DATE =
	/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}), (\d{4})\b/;

// The day a written date names, at midnight UTC; null when it names no real day.
function writtenDay(text: string): Date | null {
	const match = WRITTEN_DATE.exec(text);
	if (match === null) {
		return null;
	}
	const month = MONTHS.indexOf((match[1] || "").toLowerCase());
	const day = Number(match[2]);
	const at = new Date(Date.UTC(Number(match[3]), month, day));
	if (at.getUTCDate() !== day) {
		return null;
	}
	return at;
}

// A link's date: its <time datetime>, else a date written in its text; null when it has neither.
function linkDate(inner: string, text: string): Date | null {
	for (const tag of tagsNamed(inner, ["time"])) {
		const value = attribute(tag.text, "datetime");
		if (value !== null && !Number.isNaN(new Date(value).getTime())) {
			return new Date(value);
		}
	}
	return writtenDay(text);
}

// A link's title: its first heading when it has one, else its text with the date taken out.
function linkTitle(inner: string, text: string): string {
	const tags = tagsNamed(inner, ["h1", "h2", "h3", "h4", "h5", "h6"]);
	const open = tags.find((tag) => !tag.closing);
	const close = tags.find(
		(tag) => tag.closing && open !== undefined && tag.start > open.start,
	);
	let title = text.replace(WRITTEN_DATE, " ");
	if (open !== undefined && close !== undefined) {
		title = markupToText(inner.slice(open.end, close.start));
	}
	return cutAtWord(title.replace(/\s+/g, " ").trim(), TITLE_MAX);
}

// The posts a page links to: links whose absolute URL matches `links`, each URL once, its first dated link kept.
export function pageItems(
	html: string,
	pageUrl: string,
	links: string,
): Item[] {
	const pattern = new RegExp(links);
	const tags = tagsNamed(html, ["a"]);
	const items: Item[] = [];
	const seen = new Set<string>();
	tags.forEach((open, k) => {
		const close = tags[k + 1];
		if (open.closing || close === undefined || !close.closing) {
			return;
		}
		const href = attribute(open.text, "href");
		if (href === null) {
			return;
		}
		const url = URL.parse(href, pageUrl);
		if (url === null || !pattern.test(url.href) || seen.has(url.href)) {
			return;
		}
		const inner = html.slice(open.end, close.start);
		const text = markupToText(inner);
		const at = linkDate(inner, text);
		const title = linkTitle(inner, text);
		if (at === null || title === "") {
			return;
		}
		seen.add(url.href);
		items.push({
			title: title,
			url: url.href,
			at: at,
			authors: [],
			description: "",
			categories: [],
		});
	});
	if (items.length === 0) {
		throw new ReadProblem("answered with a page that links to no dated post");
	}
	return items;
}
