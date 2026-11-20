// The newsfeed's reader for RSS, RDF and Atom feeds.
import { XMLParser } from "fast-xml-parser";
import { isJsonObject } from "../../../shared/narrow.ts";
import {
	authorNames,
	type Item,
	list,
	plainText,
	ReadProblem,
	usableDescription,
} from "./item.ts";

// Elements that may repeat, so they always parse as lists.
const LISTS = new Set([
	"item",
	"entry",
	"link",
	"category",
	"author",
	"dc:creator",
]);
const PARSER = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@",
	parseTagValue: false,
	isArray: (name) => LISTS.has(name),
});

// An Atom entry's link: the alternate one, or the first.
function atomLink(links: unknown[]): string {
	const alternate = links.find(
		(l) =>
			isJsonObject(l) && (l["@rel"] === undefined || l["@rel"] === "alternate"),
	);
	const chosen = alternate || links[0];
	if (isJsonObject(chosen) && typeof chosen["@href"] === "string") {
		return chosen["@href"];
	}
	return plainText(chosen);
}

// The items of an RSS or Atom document, relative links resolved against `feedUrl`; items without a title, link or
// date are left out.
export function feedItems(body: string, feedUrl: string): Item[] {
	let document: unknown;
	try {
		document = PARSER.parse(body);
	} catch {
		throw new ReadProblem("answered with something that isn't a feed");
	}
	if (!isJsonObject(document)) {
		throw new ReadProblem("answered with something that isn't a feed");
	}
	let raw: unknown[];
	let atom = false;
	const rss = document.rss;
	const rdf = document["rdf:RDF"];
	if (isJsonObject(rss) && isJsonObject(rss.channel)) {
		raw = list(rss.channel.item);
	} else if (isJsonObject(rdf)) {
		raw = list(rdf.item);
	} else if (isJsonObject(document.feed)) {
		raw = list(document.feed.entry);
		atom = true;
	} else {
		throw new ReadProblem("answered with something that isn't a feed");
	}
	const items: Item[] = [];
	for (const entry of raw) {
		if (!isJsonObject(entry)) {
			continue;
		}
		const link = atom ? atomLink(list(entry.link)) : plainText(entry.link);
		const resolved = URL.parse(link, feedUrl);
		let url = "";
		if (link !== "" && resolved !== null) {
			url = resolved.href;
		}
		const date = plainText(
			entry.pubDate || entry.published || entry["dc:date"] || entry.updated,
		);
		const at = new Date(date);
		const title = plainText(entry.title);
		if (
			title === "" ||
			!/^https?:\/\//.test(url) ||
			Number.isNaN(at.getTime())
		) {
			continue;
		}
		const description = usableDescription([
			entry.description,
			entry.summary,
			entry["content:encoded"],
			entry.content,
		]);
		items.push({
			title: title,
			url: url,
			at: at,
			authors: authorNames(list(entry["dc:creator"] || entry.author)),
			description: description,
			categories: list(entry.category).map((c) => {
				if (isJsonObject(c) && typeof c["@term"] === "string") {
					return c["@term"];
				}
				return plainText(c);
			}),
		});
	}
	return items;
}
