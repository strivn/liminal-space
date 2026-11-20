// Each topic's headlines from Google News for the search plan.
import { decodeXML } from "entities";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { daysBefore } from "../../lib/run-date.ts";
import type { Run } from "../arxiv/search.ts";
import { HOUR_MS, TITLE_CHARS } from "../arxiv/search.ts";
import type { Topic } from "../plan/interests.ts";
import { cut, newsQueries } from "../plan/interests.ts";
import { download, downloadProblem } from "../proceedings/venue-lists.ts";

const NEWS_RSS = process.env.NEWS_RSS || "https://news.google.com/rss/search";
const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
	timeZone: CONSTANTS.timeZone,
});
const NEWS_LINES = 5;
// Google News doesn't always hold to when:2d, so older headlines are left out here.
const NEWS_HOURS = 48;

// The text of an RSS item's first <tag>: XML entities decoded once, whitespace collapsed; '' when the item has none.
function itemText(item: string, tag: string) {
	const match = item.match(
		new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`),
	);
	if (match === null) {
		return "";
	}
	return decodeXML(match[1] || "")
		.replace(/\s+/g, " ")
		.trim();
}

// One topic's headlines from Google News over the last 2 days, newest first, at most 5, as "<date> <source>:
// <headline>". The search is the topic's line in "News phrases" (`news`); a topic without one (`news` undefined) is
// searched with its search phrases, and its header says so. A headline published more than 48 hours before the run
// started (`runStart`, in ms), or with no readable date, is left out and counted. The feed's links are Google
// redirects, so none are printed. Returns the lines to print, header first.
// `date` is the day given with --date, null without: Google News is then asked for after:<3 days before> and
// before:<the day after> instead of when:2d, and a headline published after the run moment is left out too.
export async function searchNews(
	topic: Topic,
	news: Topic | undefined,
	runStart: number,
	date: string | null,
	run: Run,
): Promise<string[]> {
	let window = "when:2d";
	if (date !== null) {
		window = `after:${daysBefore(date, 3)} before:${daysBefore(date, -1)}`;
	}
	let phrases = topic.phrases;
	let label = `news, topic ${topic.topic} (`;
	if (news !== undefined) {
		phrases = news.phrases;
	} else {
		label +=
			"no news phrases in interests.md, searched with its search phrases; ";
	}
	// Every item the topic's searches found, once each by its title (headline and source), in the order found.
	const byTitle = new Map<string, string>();
	for (const query of newsQueries(phrases)) {
		const url = `${NEWS_RSS}?q=${encodeURIComponent(`${query} ${window}`)}&hl=en-US&gl=US&ceid=US:en`;
		// biome-ignore lint/performance/noAwaitInLoops: one request at a time to Google News
		const answer = await download(url, {});
		let problem = null;
		let body = ""; // the feed, once it is known to be one
		if (!answer.ok) {
			problem = downloadProblem(answer);
		} else if (!answer.body.includes("<channel")) {
			// A consent or login page answered with 200 would otherwise read as no news.
			problem = "answered with something that isn't an RSS feed";
		} else {
			body = answer.body;
		}
		if (problem !== null) {
			console.error(`search.ts: Google News ${problem} (${url})`);
			run.failed = true;
			return [`${label}not read: ${problem}):`];
		}
		for (const match of body.matchAll(
			/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g,
		)) {
			const item = match[1] || "";
			const title = itemText(item, "title");
			if (!byTitle.has(title)) {
				byTitle.set(title, item);
			}
		}
	}

	let found = 0;
	let old = 0; // published more than 48 hours before the run, after it (with --date), or undated
	const items = [];
	for (const item of byTitle.values()) {
		found += 1;
		// pubDate is RFC 822, "Mon, 05 Oct 2026 07:00:00 GMT"; NaN when it can't be read.
		const time = Date.parse(itemText(item, "pubDate"));
		const tooOld = runStart - time > NEWS_HOURS * HOUR_MS;
		const tooNew = date !== null && time > runStart;
		if (Number.isNaN(time) || tooOld || tooNew) {
			old += 1;
			continue;
		}
		const source = itemText(item, "source");
		let headline = itemText(item, "title");
		// Google News ends each headline with " - <source>", which the line already shows.
		const suffix = ` - ${source}`;
		if (source !== "" && headline.endsWith(suffix)) {
			headline = headline.slice(0, headline.length - suffix.length);
		}
		items.push({ time: time, source: source, headline: headline });
	}
	// Newest first.
	items.sort((a, b) => b.time - a.time);
	const printed = items.slice(0, NEWS_LINES);
	const leftOut = items.length - printed.length;

	let header = `${label}${found} found`;
	if (old > 0 && date !== null) {
		header += `, ${old} outside the ${NEWS_HOURS} hours or undated`;
	} else if (old > 0) {
		header += `, ${old} older than ${NEWS_HOURS} hours or undated`;
	}
	if (leftOut > 0) {
		header += `, ${leftOut} left out`;
	}
	const lines = [`${header}):`];
	for (const item of printed) {
		const parts = [JAKARTA_DATE.format(new Date(item.time))];
		if (item.source !== "") {
			parts.push(`${item.source}:`);
		}
		parts.push(cut(item.headline, TITLE_CHARS));
		lines.push(parts.join(" "));
	}
	if (printed.length === 0) {
		lines.push("none");
	}
	return lines;
}
