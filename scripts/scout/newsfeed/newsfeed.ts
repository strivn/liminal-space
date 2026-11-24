// Collect the day's newsfeed: every new item from the sources in feeds.json, as each source published it, with no
// model choosing. Reads RSS, Atom, LessWrong's GraphQL API, OpenRouter's model list and the post links on a lab's
// blog page, never the posts themselves. Writes the new items as an items file
// for `digests.ts add`; with nothing new it writes none and prints "nothing new".
// Usage: node scripts/scout/newsfeed/newsfeed.ts <feeds file> <digests file> <items file>
// A source that can't be read is named on stderr and the run goes on; the exit code is then 1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	ADDED_TYPES,
	cutAtWord,
	normalizeUrl,
	readLines,
} from "../../../shared/entry-checks.ts";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../../shared/narrow.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { feedItems } from "./feed.ts";
import {
	download,
	type Item,
	ReadProblem,
	type Source,
	WINDOW_MS,
} from "./item.ts";
import { lesswrongItems } from "./lesswrong.ts";
import { releaseItems } from "./openrouter.ts";
import { pageItems } from "./page.ts";

const fail: Fail = failer("newsfeed.ts");

const USAGE =
	"usage: node scripts/scout/newsfeed/newsfeed.ts <feeds file> <digests file> <items file>";
// LessWrong posts off the frontpage get their tags days after posting (all tagged by day 4).
const LATE_TAG_WINDOW_MS = 7 * 24 * 3600 * 1000;
// The most characters of a description that are kept; a longer one is cut at a word and ends in "…".
const DESCRIPTION_MAX = 300;
const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
	timeZone: CONSTANTS.timeZone,
});

function isTextList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// True for a non-empty string that compiles as a regular expression.
function isPattern(value: unknown): value is string {
	if (typeof value !== "string" || value === "") {
		return false;
	}
	try {
		new RegExp(value);
		return true;
	} catch {
		return false;
	}
}

// What is wrong with source `entry`, or null when it can be read.
function sourceProblem(entry: unknown): string | null {
	if (!isJsonObject(entry)) {
		return "is not an object";
	}
	if (typeof entry.name !== "string" || entry.name.trim() === "") {
		return "name is missing";
	}
	if (
		!["feed", "lesswrong", "page", "openrouter"].includes(String(entry.kind))
	) {
		return 'kind must be "feed", "lesswrong", "page" or "openrouter"';
	}
	const providers = entry.providers;
	if (
		entry.kind === "openrouter" &&
		!(isTextList(providers) && providers.length > 0)
	) {
		return "providers must be a list of names, on an openrouter source";
	}
	if (entry.kind !== "openrouter" && providers !== undefined) {
		return "providers must be a list of names, on an openrouter source";
	}
	if (entry.kind === "page" && !isPattern(entry.links)) {
		return "links must be a regular expression, on a page source";
	}
	if (entry.kind !== "page" && entry.links !== undefined) {
		return "links must be a regular expression, on a page source";
	}
	if (!ADDED_TYPES.includes(entry.type)) {
		return "type must be news, article or report";
	}
	if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
		return "url is missing";
	}
	if (
		entry.kind === "lesswrong" &&
		entry.view !== "frontpage" &&
		entry.view !== "offFrontpage"
	) {
		return 'view must be "frontpage" or "offFrontpage"';
	}
	if (
		entry.minKarma !== undefined &&
		(entry.kind !== "lesswrong" || typeof entry.minKarma !== "number")
	) {
		return "minKarma must be a number, on a lesswrong source";
	}
	if (
		entry.max !== undefined &&
		!(Number.isInteger(entry.max) && Number(entry.max) > 0)
	) {
		return "max must be a whole number above 0";
	}
	if (
		entry.timeoutMs !== undefined &&
		!(Number.isInteger(entry.timeoutMs) && Number(entry.timeoutMs) > 0)
	) {
		return "timeoutMs must be a whole number above 0";
	}
	for (const key of ["categories", "excludeCategories", "tags"]) {
		if (entry[key] !== undefined && !isTextList(entry[key])) {
			return `${key} must be a list of names`;
		}
	}
	return null;
}

// The sources in a feeds file; stops at the first source that can't be read, before any request.
function readSources(file: string): Source[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`${file} can't be read as JSON (${errorCode(error) || "not JSON"})`);
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.sources)) {
		fail(`${file} holds no "sources" list`);
	}
	const sources: unknown[] = parsed.sources;
	sources.forEach((entry, k) => {
		const problem = sourceProblem(entry);
		if (problem !== null) {
			fail(`source ${k + 1} in ${file}: ${problem}`);
		}
	});
	// sourceProblem found every entry readable.
	return sources as Source[];
}

// LessWrong and the Alignment Forum share posts under one id; any other link is its own key.
function repeatKey(url: string): string {
	const match =
		/(?:lesswrong|alignmentforum)\.(?:org|com)\/posts\/([A-Za-z0-9]+)/.exec(
			url,
		);
	if (match) {
		return `lesswrong:${match[1]}`;
	}
	return normalizeUrl(url);
}

// The repeat keys of every entry the digests file already has.
function knownKeys(file: string): Set<string> {
	const keys = new Set<string>();
	if (!existsSync(file)) {
		return keys;
	}
	for (const line of readLines(readFileSync(file, "utf8"))) {
		if (!isJsonObject(line.digest) || !Array.isArray(line.digest.entries)) {
			continue;
		}
		const entries: unknown[] = line.digest.entries;
		for (const entry of entries) {
			if (isJsonObject(entry) && typeof entry.url === "string") {
				keys.add(repeatKey(entry.url));
			}
		}
	}
	return keys;
}

// A source's items in its window and kept categories, none in a left-out one.
async function readSource(source: Source, now: number): Promise<Item[]> {
	let items: Item[];
	let windowMs = WINDOW_MS;
	switch (source.kind) {
		case "lesswrong":
			items = await lesswrongItems(source);
			if (source.view === "offFrontpage") {
				windowMs = LATE_TAG_WINDOW_MS;
			}
			break;
		case "feed":
			items = feedItems(
				await download(source.url, source.timeoutMs),
				source.url,
			);
			break;
		case "page":
			items = pageItems(
				await download(source.url, source.timeoutMs),
				source.url,
				source.links || "",
			);
			break;
		case "openrouter":
			items = releaseItems(
				await download(source.url, source.timeoutMs),
				source.providers || [],
				now,
			);
			break;
	}
	const kept = new Set(source.categories || []);
	const left = new Set(source.excludeCategories || []);
	return items.filter(
		(item) =>
			now - item.at.getTime() <= windowMs &&
			(kept.size === 0 || item.categories.some((c) => kept.has(c))) &&
			!item.categories.some((c) => left.has(c)),
	);
}

// The `count` items with the most karma.
function mostKarma(items: Item[], count: number): Item[] {
	return items
		.slice()
		.sort((a, b) => (b.karma || 0) - (a.karma || 0))
		.slice(0, count);
}

// `count` of `items` picked at random (Fisher-Yates on a copy); all of them when there are no more than `count`.
function pickAtRandom(items: Item[], count: number): Item[] {
	const shuffled = items.slice();
	for (let k = shuffled.length - 1; k > 0; k--) {
		const other = Math.floor(Math.random() * (k + 1));
		[shuffled[k], shuffled[other]] = [
			shuffled[other] as Item,
			shuffled[k] as Item,
		];
	}
	return shuffled.slice(0, count);
}

// An item as a digests entry from `source`.
function entryOf(item: Item, source: Source): JsonObject {
	const entry: JsonObject = {
		type: source.type,
		title: item.title,
		published: JAKARTA_DATE.format(item.at),
		source: source.name,
		url: item.url,
	};
	if (item.authors.length > 0) {
		entry.authors = item.authors;
	}
	if (item.description !== "") {
		entry.description = cutAtWord(item.description, DESCRIPTION_MAX);
	}
	return entry;
}

async function main(args: string[]) {
	if (args.length !== 3) {
		console.error(USAGE);
		process.exit(2);
	}
	const [feedsFile, digestsFile, itemsFile] = args as [string, string, string];
	const sources = readSources(feedsFile);
	const known = knownKeys(digestsFile);
	const now = Date.now();

	// Every source at once; one that fails is named and the rest go on.
	const results = await Promise.allSettled(
		sources.map((s) => readSource(s, now)),
	);
	// Each outlet's new items, pooled across its sources and in the order feeds.json lists them; each item once.
	const outlets = new Map<string, { source: Source; items: Item[] }>();
	results.forEach((result, k) => {
		const source = sources[k] as Source;
		if (result.status === "rejected") {
			const reason = result.reason;
			if (!(reason instanceof ReadProblem)) {
				throw reason;
			}
			console.error(
				`newsfeed.ts: ${source.name} (${source.url}) not read: ${reason.message}`,
			);
			process.exitCode = 1;
			return;
		}
		let outlet = outlets.get(source.name);
		if (outlet === undefined) {
			outlet = { source: source, items: [] };
			outlets.set(source.name, outlet);
		}
		for (const item of result.value) {
			const key = repeatKey(item.url);
			if (!known.has(key)) {
				known.add(key);
				outlet.items.push(item);
			}
		}
	});

	// Then each outlet's daily number of them: LessWrong's with the most karma, any other's at random.
	const entries: JsonObject[] = [];
	for (const { source, items } of outlets.values()) {
		let picked = items;
		if (source.max !== undefined && source.kind === "lesswrong") {
			picked = mostKarma(items, source.max);
		} else if (source.max !== undefined) {
			picked = pickAtRandom(items, source.max);
		}
		for (const item of picked) {
			entries.push(entryOf(item, source));
			console.log(`new ${source.name}: ${item.title}`);
		}
	}

	if (entries.length === 0) {
		console.log("nothing new");
		return;
	}
	writeFileSync(itemsFile, `${JSON.stringify(entries, null, "\t")}\n`);
	console.log(`wrote ${entries.length} items to ${itemsFile}`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
