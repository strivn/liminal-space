// Store each newsfeed source's icon in the site, since the page's CSP loads images only from itself.
// The icon is the source's own "icon" in feeds.json, else the one its feed names (RSS <image><url>, Atom <icon> or
// <logo>), else the host's /favicon.ico.
// Never reads a web page. Writes <icons folder>/<host>.<ext> and <icons folder>/index.json ({ host: file }), which
// the page bundles to put the icon before a news item's title. Run it again after adding a source to feeds.json.
// Usage: node scripts/scout/newsfeed/icons.ts <feeds file> <icons folder>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { isJsonObject } from "../../../shared/narrow.ts";
import { type HttpAnswer, request } from "../../lib/http.ts";

const USAGE =
	"usage: node scripts/scout/newsfeed/icons.ts <feeds file> <icons folder>";
const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/svg+xml": "svg",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
};
const PARSER = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

type Source = { kind: string; url: string; icon?: string };

// One GET with this project's user agent and time limit; throws when no answer came.
async function get(url: string): Promise<HttpAnswer> {
	const answer = await request(url);
	if ("problem" in answer) {
		throw new Error(`${url} ${answer.problem}`);
	}
	return answer;
}

// The icon a feed names for itself, or null.
async function feedIcon(url: string): Promise<string | null> {
	const answer = await get(url);
	if (!answer.ok) {
		return null;
	}
	const document: unknown = PARSER.parse(answer.text());
	if (!isJsonObject(document)) {
		return null;
	}
	const channel = isJsonObject(document.rss) ? document.rss.channel : null;
	if (isJsonObject(channel) && isJsonObject(channel.image)) {
		const image = channel.image.url;
		return typeof image === "string" ? image.trim() : null;
	}
	if (isJsonObject(document.feed)) {
		const icon = document.feed.icon || document.feed.logo;
		return typeof icon === "string" ? icon.trim() : null;
	}
	return null;
}

// Download an image; its bytes and extension, or null when the answer isn't an image.
async function image(
	url: string,
): Promise<{ bytes: Buffer; ext: string } | null> {
	const answer = await get(url);
	const type = (answer.headers.get("content-type") || "").split(";")[0] || "";
	const ext = EXTENSIONS[type.trim()];
	if (!answer.ok || ext === undefined) {
		return null;
	}
	return { bytes: answer.bytes, ext: ext };
}

// Whether an image is square enough to sit before a title: an ICO or SVG is taken as square, a PNG or GIF is read
// from its header, anything else (a JPEG) counts as not square. Feed images are often banners, such as NYT's 250x40.
function isSquare(found: { bytes: Buffer; ext: string }): boolean {
	const { bytes, ext } = found;
	let width = 0;
	let height = 0;
	if (ext === "ico" || ext === "svg") {
		return true;
	}
	if (ext === "png" && bytes.length >= 24) {
		width = bytes.readUInt32BE(16);
		height = bytes.readUInt32BE(20);
	} else if (ext === "gif" && bytes.length >= 10) {
		width = bytes.readUInt16LE(6);
		height = bytes.readUInt16LE(8);
	}
	return (
		width > 0 &&
		height > 0 &&
		Math.max(width, height) / Math.min(width, height) <= 1.2
	);
}

// The host a source's items link to, and its icon: the first square candidate, else the first image found; no
// bytes when no candidate is an image.
async function iconFor(source: Source) {
	let host = new URL(source.url).host;
	let candidates = [`https://${host}/favicon.ico`];
	if (source.kind === "lesswrong") {
		host = "www.lesswrong.com";
		candidates = [`https://${host}/favicon.ico`];
	} else if (source.icon !== undefined) {
		candidates.unshift(source.icon);
	} else {
		const named = await feedIcon(source.url);
		if (named !== null) {
			candidates.unshift(new URL(named, source.url).href);
		}
	}
	let fallback: { bytes: Buffer; ext: string } | null = null;
	for (const candidate of candidates) {
		// biome-ignore lint/performance/noAwaitInLoops: first square image wins
		const found = await image(candidate);
		if (found !== null && isSquare(found)) {
			return { host: host, ...found };
		}
		fallback = fallback || found;
	}
	if (fallback !== null) {
		return { host: host, ...fallback };
	}
	return { host: host, bytes: null, ext: null };
}

async function main(args: string[]) {
	if (args.length !== 2) {
		console.error(USAGE);
		process.exit(2);
	}
	const [feedsFile, folder] = args as [string, string];
	const parsed: unknown = JSON.parse(readFileSync(feedsFile, "utf8"));
	if (!isJsonObject(parsed) || !Array.isArray(parsed.sources)) {
		console.error(`icons.ts: ${feedsFile} holds no "sources" list`);
		process.exit(1);
	}
	const sources = parsed.sources as Source[];
	mkdirSync(folder, { recursive: true });

	// Every source at once; one that fails gets no icon and is named.
	const found = await Promise.allSettled(sources.map(iconFor));
	const index: Record<string, string> = {};
	found.forEach((result, k) => {
		const source = sources[k] as Source;
		if (result.status === "rejected" || result.value.bytes === null) {
			console.error(`icons.ts: no icon for ${source.url}`);
			return;
		}
		const { host, bytes, ext } = result.value;
		const file = `${host}.${ext}`;
		writeFileSync(join(folder, file), bytes);
		index[host] = file;
		console.log(`stored ${file}`);
	});
	const sorted = Object.fromEntries(Object.entries(index).sort());
	writeFileSync(
		join(folder, "index.json"),
		`${JSON.stringify(sorted, null, "\t")}\n`,
	);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
