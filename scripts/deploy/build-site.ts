// Build the folder Cloudflare serves for ivan.wiryadi.com/liminal-space/ from a digests file.
// Usage: node scripts/deploy/build-site.ts [--staging <commit>] [--study <study file>] <digests file> <output folder>
// --study adds study/ (words files, character files and the licences they ship with) and names each studied entry's
// words file in data/index.json; the month files are the same with or without it.
// Writes <output folder>/liminal-space/: the page's own files from site/, the owner's copy of the page in owner/
// (Access guards that path; the page knows it is the owner's from where it was opened), data/index.json with
// data/months/*.json, data/search.json (each entry's topic, keywords and venue) and
// data/selected.json, the owner's marked papers with their notes, from digests.standouts.json
// beside the digests file (none when it isn't there; shapes in shared/site-data-shape.ts), and digests/ with one Markdown file a day and index.md for
// agents (entries only, never the owner's notes), and sitemap.xml. Beside it, _headers, _redirects
// and robots.txt from HEADERS, REDIRECTS and ROBOTS below.
// site/app.js must be built first (pnpm run build). The new build is written beside the output folder and moved over
// it only when complete, so a failed build leaves the earlier one as it was. A line that doesn't load stops the build.
// Environment: LIMINAL_SITE (the folder the page's own files come from, else site/ in the repo; tests point it at a
// copy they change).
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	hasText,
	isDay,
	readLines,
	UnloadedLine,
} from "../../shared/entry-checks.ts";
import { digestMarkdown } from "../../shared/entry-markdown.ts";
import { LAB_FIGURE_ADDRESSES } from "../../shared/lab-figures.ts";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../shared/narrow.ts";
import {
	type CharDictionaryRow,
	type CharDrawing,
	type CharFile,
	type CharPart,
	charFilePath,
	INDEX_PATH,
	type IndexDay,
	type IndexEntry,
	MONTHS_FOLDER,
	type MonthLine,
	SEARCH_PATH,
	SELECTED_PATH,
	type SearchEntry,
	type SearchFile,
	type SelectedFile,
	type SelectedPaper,
	type SiteIndex,
	STUDY_CHARS_FOLDER,
	STUDY_FOLDER,
} from "../../shared/site-data-shape.ts";
import { standoutsPath } from "../lib/standouts.ts";

// The page's own files in site/ (or LIMINAL_SITE), copied: files, then whole folders. versionReferences then rewrites
// the kept files' addresses in the HTML and CSS.
const SITE_FOLDER =
	process.env.LIMINAL_SITE ||
	fileURLToPath(new URL("../../site/", import.meta.url));
const PAGE_FILES = [
	"index.html",
	"app.js",
	"claude-markdown.js",
	"study-strokes.js",
	"style.css",
	"arxiv-logomark-small.svg",
	"claude-sonnet.svg",
	"manifest.webmanifest",
];
const PAGE_FOLDERS = ["katex", "fonts", "icons", "app-icon"];
// The folder under the output folder that mirrors the path the page is served at.
const PAGE_PATH = "liminal-space";
// The owner's page, a folder below the page: Access guards that path.
const OWNER_FOLDER = "owner";
// The Markdown digests, a folder below the page.
const DIGESTS_FOLDER = "digests";
// An href or src attribute holding a relative address: not a scheme like "data:" or "https:", not "/..." and not
// "#...". The CSP's base-uri 'none' rules out a <base> element, so the owner's copy rewrites these instead.
const RELATIVE_ADDRESS = /\b(href|src)="(?![a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/g;
// Only the owner's copy links the manifest, whose start_url is the owner's page: a visitor who adds the public page to
// a Home Screen then opens the public page, never the Access login. The manifest sits on the public path, so fetching
// it needs no Access cookie.
const OWNER_MANIFEST_LINK =
	'  <link rel="manifest" href="../manifest.webmanifest">\n</head>';
// The public page preloads data/selected.json; the owner's Selected reads its own saved marks instead.
const SELECTED_PRELOAD =
	'  <link rel="preload" href="data/selected.json" as="fetch" crossorigin>\n';
// The owner's page div gets page--owner, from the first frame: its column is wider by the rail's second column.
const OWNER_PAGE_CLASS = {
	from: 'class="page page--with-contents"',
	to: 'class="page page--with-contents page--owner"',
};
// Scripts only from the page's own files and Cloudflare's Web Analytics beacon, named by its host: its file path
// carries a hash. Images also come from data: addresses and arXiv (Figure 1). The manifest comes from the site.
const LAB_IMAGES = [...new Set(Object.values(LAB_FIGURE_ADDRESSES).flat())];
const CONTENT_SECURITY_POLICY =
	"default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; " +
	`img-src 'self' data: https://arxiv.org ${LAB_IMAGES.join(" ")}; ` +
	"font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
	// Only DOMPurify may write HTML.
	"require-trusted-types-for 'script'; trusted-types dompurify";
// A file a browser keeps for a year without asking again.
const KEEP_A_YEAR = "  Cache-Control: public, max-age=31536000, immutable";
// The page's own files a browser keeps for a year, relative to the page's folder ("/" ends a folder). The page asks
// for each with "?v=<its content hash>" (versionReferences), so a deploy that changes one gives it a new address.
const KEPT_FILES = [
	"app.js",
	"claude-markdown.js",
	"study-strokes.js",
	"style.css",
	"katex/",
	"fonts/",
];
// The source icons are named by the page's script, which can't version them: a browser keeps them for a day.
const KEEP_A_DAY = "  Cache-Control: public, max-age=86400";
// A reference to a file: an href or src attribute in HTML, a url() in CSS. The address is the second group; one
// that already holds a query or a fragment isn't touched.
const HTML_REFERENCE = /\b(href|src)="([^"?#]+)"/g;
const CSS_REFERENCE = /url\((["']?)([^"'?#)]+)\1\)/g;
// A dynamic import in the page's script: the address is the second group, counted from the script's own folder.
const SCRIPT_REFERENCE = /\b(import)\("([^"?#]+)"\)/g;
// Cloudflare's header rules: month files never change under their name; the index may change with every deploy;
// kept files a year, icons a day. Every file of the site gets the standard security headers. HSTS holds for the
// whole host ivan.wiryadi.com, as browsers apply it per host.
const HEADERS = [
	`/${PAGE_PATH}/${MONTHS_FOLDER}/*`,
	KEEP_A_YEAR,
	`/${PAGE_PATH}/${INDEX_PATH}`,
	"  Cache-Control: no-cache",
	`/${PAGE_PATH}/${STUDY_FOLDER}/words/*`,
	"  Cache-Control: no-cache",
	`/${PAGE_PATH}/${STUDY_CHARS_FOLDER}/*`,
	KEEP_A_YEAR,
	`/${PAGE_PATH}/${SELECTED_PATH}`,
	"  Cache-Control: no-cache",
	`/${PAGE_PATH}/${SEARCH_PATH}`,
	"  Cache-Control: no-cache",
	...KEPT_FILES.flatMap((kept) => [
		`/${PAGE_PATH}/${kept.replace(/\/$/, "/*")}`,
		KEEP_A_YEAR,
	]),
	`/${PAGE_PATH}/icons/*`,
	KEEP_A_DAY,
	`/${PAGE_PATH}/app-icon/*`,
	KEEP_A_DAY,
	`/${PAGE_PATH}/*`,
	`  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`,
	"/*",
	"  Strict-Transport-Security: max-age=31536000",
	"  X-Content-Type-Options: nosniff",
	"  Referrer-Policy: strict-origin-when-cross-origin",
	"  Permissions-Policy: camera=(), microphone=(), geolocation=()",
	"",
].join("\n");
// The page's public address, the one a search engine should list.
const PAGE_URL = `https://ivan.wiryadi.com/${PAGE_PATH}/`;
// The sitemap beside the page (sitemaps.org's protocol): the page is the site's one address worth listing.
const SITEMAP_FILE = "sitemap.xml";
const SITEMAP = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	`  <url><loc>${PAGE_URL}</loc></url>`,
	"</urlset>",
	"",
].join("\n");
// Cloudflare's redirect rules: the address without its last slash moves to the page for good (308), so search
// engines keep the one address. Without a rule, the files' own handling answers it with a temporary 307.
const REDIRECTS = `/${PAGE_PATH} /${PAGE_PATH}/ 308\n`;
// The paths no robot reads: the page's data, the owner's page, the sync API and the connector.
const PRIVATE_PATHS = [
	`Disallow: /${PAGE_PATH}/data/`,
	`Disallow: /${PAGE_PATH}/owner/`,
	`Disallow: /${PAGE_PATH}/api/`,
	`Disallow: /${PAGE_PATH}/mcp`,
];
// Agents a person sends to read a page (each company's user-triggered fetcher) may read the Markdown digests. Search
// engines and training crawlers may read the page but not data/ or digests/, where the entries are: they get its
// title and description only, so entries stay out of search results.
const ROBOTS = [
	"User-agent: Claude-User",
	"User-agent: ChatGPT-User",
	"User-agent: Perplexity-User",
	`Allow: /${PAGE_PATH}/${DIGESTS_FOLDER}/`,
	...PRIVATE_PATHS,
	"",
	"User-agent: *",
	`Disallow: /${PAGE_PATH}/${DIGESTS_FOLDER}/`,
	...PRIVATE_PATHS,
	"",
	`Sitemap: ${PAGE_URL}${SITEMAP_FILE}`,
	"",
].join("\n");

// A staging build: Access lets only the owner open staging, and these are a second layer for a request it
// ever lets through. Every robot keeps out of every path, no sitemap names the host, and every file tells search
// engines not to index it. The page's title starts with "Staging", and a strip across its top names the develop commit.
const STAGING_ROBOTS = "User-agent: *\nDisallow: /\n";
const STAGING_HEADERS = HEADERS.replace(
	"\n/*\n",
	"\n/*\n  X-Robots-Tag: noindex\n",
);
// A commit id, the only text a staging build writes into the page.
const COMMIT_ID = /^[0-9a-f]{7,40}$/;

// A staging build: the develop commit it runs.
export type StagingBuild = { commit: string };

// A failure that stops the build, printed as "build-site.ts: <message>".
export class BuildFailure extends Error {}

// The first 12 hex digits of the SHA-256 of a file's text, as UTF-8 bytes.
function contentHash(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// True for a path, relative to the page's folder, that KEPT_FILES names or lies in a folder it names.
function isKept(relative: string) {
	return KEPT_FILES.some(
		(kept) =>
			relative === kept || (kept.endsWith("/") && relative.startsWith(kept)),
	);
}

// Give every reference in a built file of the page to a kept file "?v=<the first 12 hex digits of its SHA-256>",
// rewriting the file in place. `relative` is the file's path under the page's folder; its references count from its
// own folder. The kept file is read from the build, so a reference to a file this function rewrote names its new
// content: call it on a file only after the files it references.
function versionReferences(page: string, relative: string, pattern: RegExp) {
	const file = join(page, relative);
	const from = posix.dirname(relative);
	const text = readFileSync(file, "utf8").replace(
		pattern,
		(reference: string, _before: string, address: string) => {
			const target = posix.normalize(posix.join(from, address));
			if (!isKept(target) || !existsSync(join(page, target))) {
				return reference;
			}
			const hash = createHash("sha256")
				.update(readFileSync(join(page, target)))
				.digest("hex")
				.slice(0, 12);
			return reference.replace(address, `${address}?v=${hash}`);
		},
	);
	writeFileSync(file, text);
}

// The index's view of a line's entries: the id and type of each entry with a text id, in order. An entry without
// one can't be drawn or linked to, so the index doesn't count it.
function indexEntries(entries: unknown[]): IndexEntry[] {
	const listed: IndexEntry[] = [];
	for (const entry of entries) {
		if (!isJsonObject(entry) || typeof entry.id !== "string") {
			continue;
		}
		let type = "";
		if (typeof entry.type === "string") {
			type = entry.type;
		}
		listed.push({ id: entry.id, type: type });
	}
	return listed;
}

// Sort order for days: newest date first. Dates are compared as text, as YYYY-MM-DD sorts.
function newestFirst(a: IndexDay, b: IndexDay) {
	if (a.date > b.date) {
		return -1;
	}
	if (a.date < b.date) {
		return 1;
	}
	return 0;
}

// The index and the month files for a digests text: month file names (relative to data/) to their JSON text.
// Lines are grouped by the first 7 characters of their date; days merge lines with one date, newest day first.
// Throws "line <n> doesn't load ..." for a line that doesn't load.
export function siteData(text: string): {
	index: SiteIndex;
	months: Map<string, string>;
} {
	// Each month's lines in file order, and each date's day, in the order dates first appear.
	const monthLines = new Map<string, MonthLine[]>();
	const days = new Map<string, IndexDay>();
	for (const line of readLines(text)) {
		if (line.problem !== undefined) {
			throw new UnloadedLine(line.number, line.problem);
		}
		const digest = line.digest;
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) {
			throw new UnloadedLine(
				line.number,
				"doesn't load (entries must be a list)",
			);
		}
		// The date names files, so it must be a real day.
		if (!isDay(digest.date)) {
			throw new UnloadedLine(
				line.number,
				"doesn't load (date must be YYYY-MM-DD)",
			);
		}
		// The line as a month file holds it: its date and its entries, every field as the file has it.
		const date = digest.date;
		const entries: unknown[] = digest.entries;
		const month = date.slice(0, 7);
		let lines = monthLines.get(month);
		if (lines === undefined) {
			lines = [];
			monthLines.set(month, lines);
		}
		lines.push({ date: date, entries: entries });
		let day = days.get(date);
		if (day === undefined) {
			day = { date: date, month: month, entries: [] };
			days.set(date, day);
		}
		for (const listed of indexEntries(entries)) {
			day.entries.push(listed);
		}
	}

	// One file per month, named by its content.
	const months = new Map<string, string>();
	const monthNames: Record<string, string> = {};
	monthLines.forEach((lines, month) => {
		const json = JSON.stringify({ lines: lines });
		const name = `months/${month}.${contentHash(json)}.json`;
		months.set(name, json);
		monthNames[month] = name;
	});
	const sortedDays = Array.from(days.values()).sort(newestFirst);
	return { index: { days: sortedDays, months: monthNames }, months: months };
}

// The Markdown digests for agents: file names under digests/ to their text, one YYYY-MM-DD.md
// a day and index.md listing the days newest first, from the index and month files siteData made. Entries only, never
// the owner's notes. A day's entries are its lines' entries in file order; digestMarkdown groups them as the page's contents do.
export function digestFiles(
	data: ReturnType<typeof siteData>,
): Map<string, string> {
	// Each day's entries, from its month's lines.
	const entriesByDay = new Map<string, JsonObject[]>();
	data.months.forEach((json) => {
		const month: { lines: MonthLine[] } = JSON.parse(json);
		for (const line of month.lines) {
			let entries = entriesByDay.get(line.date);
			if (entries === undefined) {
				entries = [];
				entriesByDay.set(line.date, entries);
			}
			for (const entry of line.entries) {
				if (isJsonObject(entry) && typeof entry.id === "string") {
					entries.push(entry);
				}
			}
		}
	});

	const files = new Map<string, string>();
	const listed: string[] = [];
	for (const day of data.index.days) {
		const entries = entriesByDay.get(day.date) || [];
		files.set(`${day.date}.md`, digestMarkdown(day.date, entries));
		let count = `${entries.length} entries`;
		if (entries.length === 1) {
			count = "1 entry";
		}
		listed.push(`- [${day.date}](${day.date}.md): ${count}`);
	}
	let list = "No digests yet.";
	if (listed.length > 0) {
		list = listed.join("\n");
	}
	files.set(
		"index.md",
		"# Liminal space digests\n\n" +
			"A daily reading list: papers, news, articles and reports. One Markdown file a day, newest first; " +
			"each lists its entries under Papers, From the labs, LessWrong and News, in that order.\n\n" +
			`${list}\n`,
	);
	return files;
}

// The data/selected.json content.
export function selectedFile(rows: unknown): SelectedFile {
	const unreadable = new BuildFailure(
		"the marked papers must be a list of {entry, date, note}",
	);
	if (!Array.isArray(rows)) {
		throw unreadable;
	}
	const papers: SelectedPaper[] = [];
	for (const row of rows) {
		if (
			!isJsonObject(row) ||
			!isJsonObject(row.entry) ||
			typeof row.entry.id !== "string" ||
			!isDay(row.date) ||
			typeof row.note !== "string"
		) {
			throw unreadable;
		}
		papers.push({ entry: row.entry, date: row.date, note: row.note });
	}
	// Newest mark first.
	papers.sort(
		(a, b) =>
			b.date.localeCompare(a.date) ||
			entryId(a.entry).localeCompare(entryId(b.entry)),
	);
	return { papers: papers };
}

// A checked entry's id.
function entryId(entry: unknown): string {
	if (isJsonObject(entry) && typeof entry.id === "string") {
		return entry.id;
	}
	return "";
}

// The marked papers, or none.
function readSelected(digestsFile: string): SelectedFile {
	const file = standoutsPath(digestsFile);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { papers: [] };
		}
		throw new BuildFailure(`can't read ${file} (${errorCode(error)})`);
	}
	let rows: unknown;
	try {
		rows = JSON.parse(text);
	} catch {
		throw new BuildFailure(`${file} is not JSON`);
	}
	return selectedFile(rows);
}

// data/search.json from the digests' lines: each entry's date, kind, main OpenAlex topic, keywords and venue.
export function searchFile(lines: unknown[]): SearchFile {
	const entries: SearchEntry[] = [];
	for (const line of lines) {
		if (
			!isJsonObject(line) ||
			!isDay(line.date) ||
			!Array.isArray(line.entries)
		) {
			continue;
		}
		for (const entry of line.entries) {
			if (!isJsonObject(entry) || typeof entry.id !== "string") {
				continue;
			}
			entries.push({
				id: entry.id,
				date: line.date,
				type: typeof entry.type === "string" ? entry.type : "",
				topic: mainTopic(entry.openalex),
				keywords: keywordsOf(entry.openalex),
				venue: hasText(entry.venue) ? entry.venue : null,
			});
		}
	}
	return { entries: entries };
}

function mainTopic(openalex: unknown): SearchEntry["topic"] {
	if (!isJsonObject(openalex) || !Array.isArray(openalex.topics)) {
		return null;
	}
	const first: unknown = openalex.topics[0];
	if (
		!isJsonObject(first) ||
		typeof first.name !== "string" ||
		typeof first.field !== "string"
	) {
		return null;
	}
	return { name: first.name, field: first.field };
}

function keywordsOf(openalex: unknown): string[] {
	if (!isJsonObject(openalex) || !Array.isArray(openalex.keywords)) {
		return [];
	}
	return openalex.keywords.filter(
		(keyword): keyword is string => typeof keyword === "string",
	);
}

// The <link rel="preload"> line for the newest month's file, which index.html can't name itself since the name holds
// the file's hash; "" for a site with no days. crossorigin as index.html's other fetch preload says.
export function preloadLinks(index: SiteIndex): string {
	const newest = index.days[0];
	if (newest === undefined) return "";
	const file = index.months[newest.month];
	if (file === undefined) return "";
	return `  <link rel="preload" href="data/${file}" as="fetch" crossorigin>\n`;
}

// Write the whole build into `folder`, which doesn't exist yet.
function writeBuild(
	folder: string,
	data: ReturnType<typeof siteData>,
	selected: SelectedFile,
	staging: StagingBuild | null,
	study: Map<string, string> | null,
) {
	const page = join(folder, PAGE_PATH);
	mkdirSync(join(page, MONTHS_FOLDER), { recursive: true });
	for (const file of PAGE_FILES) {
		cpSync(join(SITE_FOLDER, file), join(page, file));
	}
	for (const pageFolder of PAGE_FOLDERS) {
		cpSync(join(SITE_FOLDER, pageFolder), join(page, pageFolder), {
			recursive: true,
		});
	}
	// The newest month's preload goes in beside index.html's own, before the owner's copy is made from it.
	const indexHtml = join(page, "index.html");
	const fontPreload = '  <link rel="preload" href="fonts/';
	const pageHtml = readFileSync(indexHtml, "utf8");
	if (!pageHtml.includes(fontPreload)) {
		throw new BuildFailure(
			"site/index.html has no font preload to put the month's beside",
		);
	}
	writeFileSync(
		indexHtml,
		pageHtml.replace(fontPreload, preloadLinks(data.index) + fontPreload),
	);
	// The kept files' addresses: KaTeX's and the page's fonts first, then the stylesheets naming them, then the page.
	versionReferences(page, "katex/katex.min.css", CSS_REFERENCE);
	versionReferences(page, "style.css", CSS_REFERENCE);
	versionReferences(page, "app.js", SCRIPT_REFERENCE);
	versionReferences(page, "index.html", HTML_REFERENCE);
	if (staging !== null) {
		markStaging(join(page, "index.html"), staging);
	}
	// The owner's page: index.html with every relative address one folder up, so it loads the page's own files, the
	// manifest link, and page--owner, which widens its column for the rail's second column (style.css).
	const html = readFileSync(join(page, "index.html"), "utf8");
	mkdirSync(join(page, OWNER_FOLDER));
	writeFileSync(
		join(page, OWNER_FOLDER, "index.html"),
		html
			.replace(SELECTED_PRELOAD, "")
			.replace(RELATIVE_ADDRESS, '$1="../')
			.replace("</head>", OWNER_MANIFEST_LINK)
			.replace(OWNER_PAGE_CLASS.from, OWNER_PAGE_CLASS.to),
	);
	// The owner's service worker sits in the owner's folder, so its scope is that folder and the public page can't
	// register it.
	cpSync(join(SITE_FOLDER, "sw.js"), join(page, OWNER_FOLDER, "sw.js"));
	writeFileSync(join(page, INDEX_PATH), JSON.stringify(data.index));
	writeFileSync(join(page, SELECTED_PATH), JSON.stringify(selected));
	const lines: MonthLine[] = [];
	data.months.forEach((json, name) => {
		writeFileSync(join(page, "data", name), json);
		const month: { lines: MonthLine[] } = JSON.parse(json);
		lines.push(...month.lines);
	});
	writeFileSync(join(page, SEARCH_PATH), JSON.stringify(searchFile(lines)));
	mkdirSync(join(page, DIGESTS_FOLDER));
	digestFiles(data).forEach((text, name) => {
		writeFileSync(join(page, DIGESTS_FOLDER, name), text);
	});
	study?.forEach((text, path) => {
		mkdirSync(join(page, dirname(path)), { recursive: true });
		writeFileSync(join(page, path), text);
	});
	writeFileSync(join(folder, "_redirects"), REDIRECTS);
	if (staging !== null) {
		writeFileSync(join(folder, "_headers"), STAGING_HEADERS);
		writeFileSync(join(folder, "robots.txt"), STAGING_ROBOTS);
		return;
	}
	writeFileSync(join(page, SITEMAP_FILE), SITEMAP);
	writeFileSync(join(folder, "_headers"), HEADERS);
	writeFileSync(join(folder, "robots.txt"), ROBOTS);
}

// Mark the page as staging's: "Staging · " before its title, and a strip naming the commit as the body's first element.
// The owner's copy is made from this page, so it gets both.
function markStaging(file: string, staging: StagingBuild) {
	const html = readFileSync(file, "utf8");
	const strip =
		'<div class="staging-strip" role="note" style="padding: 4px 12px; font-size: 13px; ' +
		'background: var(--warning-tint); color: var(--text); border-bottom: 2px solid var(--warning-bar)">' +
		`Staging · develop ${staging.commit.slice(0, 7)}</div>`;
	const marked = html
		.replace("<title>", "<title>Staging · ")
		.replace(/<body([^>]*)>/, `<body$1>\n${strip}`);
	if (!marked.includes("<title>Staging · ") || !marked.includes(strip)) {
		throw new BuildFailure(
			"site/index.html has no <title> and <body> to mark as staging",
		);
	}
	writeFileSync(file, marked);
}

// How every Anthropic API key starts.
const API_KEY_PREFIX = "sk-ant-";

// The first file below `folder` that holds an Anthropic API key, named by its path in the folder, or null. Every file is
// read as bytes, so a font or an image is checked as well.
function fileHoldingApiKey(folder: string): string | null {
	const found = readdirSync(folder, { recursive: true, withFileTypes: true });
	for (const entry of found) {
		if (!entry.isFile()) continue;
		const file = join(entry.parentPath, entry.name);
		if (readFileSync(file).includes(API_KEY_PREFIX)) {
			return relative(folder, file);
		}
	}
	return null;
}

// The data folders of the packages the character files come from, and the licence files beside the study files.
const HANZI_FOLDER = fileURLToPath(new URL("../lib/hanzi/", import.meta.url));
const HANZI_WRITER_DATA = dirname(
	fileURLToPath(import.meta.resolve("hanzi-writer-data/package.json")),
);
const HANZI_WRITER = dirname(
	fileURLToPath(import.meta.resolve("hanzi-writer/package.json")),
);
const STUDY_LICENCES: Record<string, string> = {
	"arphic.txt": join(HANZI_WRITER_DATA, "ARPHICPL.TXT"),
	"make-me-a-hanzi.txt": join(HANZI_FOLDER, "COPYING"),
	"lgpl-3.0.txt": join(HANZI_FOLDER, "LGPL"),
	"gpl-3.0.txt": join(HANZI_FOLDER, "GPL"),
	"hanzi-writer.txt": join(HANZI_WRITER, "LICENSE"),
};
// The marks of an ideographic description, which join components and are none themselves, and the dictionary's
// placeholder for a component it doesn't know.
const DESCRIPTION_MARK = /[⿰-⿿㇯？]/u;

// Make Me a Hanzi's rows by character, read when the first study is built.
let dictionaryRows: Map<string, CharDictionaryRow> | null = null;
function dictionaryRow(character: string): CharDictionaryRow | null {
	if (dictionaryRows === null) {
		dictionaryRows = new Map();
		const text = readFileSync(join(HANZI_FOLDER, "dictionary.txt"), "utf8");
		for (const line of text.split("\n")) {
			if (line !== "") {
				const row: CharDictionaryRow = JSON.parse(line);
				dictionaryRows.set(row.character, row);
			}
		}
	}
	return dictionaryRows.get(character) ?? null;
}

// Hanzi Writer's data for a character, or null when hanzi-writer-data has none.
function characterDrawing(character: string): CharDrawing | null {
	try {
		return JSON.parse(
			readFileSync(join(HANZI_WRITER_DATA, `${character}.json`), "utf8"),
		);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return null;
		}
		throw error;
	}
}

// The components of a row's decomposition in order, each with its own row's pinyin and definition and the role the
// row's etymology gives it.
function characterParts(row: CharDictionaryRow | null): CharPart[] {
	if (row === null) {
		return [];
	}
	const parts: CharPart[] = [];
	for (const component of row.decomposition) {
		if (DESCRIPTION_MARK.test(component)) {
			continue;
		}
		const part: CharPart = { character: component };
		const own = dictionaryRow(component);
		if (own !== null) {
			part.pinyin = own.pinyin;
			if (own.definition !== undefined) {
				part.definition = own.definition;
			}
		}
		if (row.etymology?.semantic === component) {
			part.role = "semantic";
		} else if (row.etymology?.phonetic === component) {
			part.role = "phonetic";
		}
		parts.push(part);
	}
	return parts;
}

// The words file of an entry, relative to the page's folder: study/words/ and 16 hex digits of the id's SHA-256.
export function wordsPath(entryId: string): string {
	const hash = createHash("sha256").update(entryId, "utf8").digest("hex");
	return `${STUDY_FOLDER}/words/${hash.slice(0, 16)}.json`;
}

// The studies a study file's text holds, one per line, each as the JSON text of its line. Throws "line <n> isn't a
// study" for a line that is not an object with an id, a title and a description.
function studiesIn(studyText: string): { id: string; study: JsonObject }[] {
	const studies: { id: string; study: JsonObject }[] = [];
	const lines = studyText.split("\n");
	for (let k = 0; k < lines.length; k++) {
		if (lines[k] === "") {
			continue;
		}
		let study: unknown;
		try {
			study = JSON.parse(lines[k] ?? "");
		} catch {
			study = null;
		}
		if (
			!isJsonObject(study) ||
			typeof study.id !== "string" ||
			!Array.isArray(study.title) ||
			!Array.isArray(study.description)
		) {
			throw new BuildFailure(`line ${k + 1} of the study file isn't a study`);
		}
		studies.push({ id: study.id, study: study });
	}
	return studies;
}

// The Han characters of a study's words.
function wordCharacters(study: JsonObject, into: Set<string>) {
	for (const field of [study.title, study.description]) {
		if (!Array.isArray(field)) {
			continue;
		}
		for (const piece of field) {
			if (isJsonObject(piece) && "syllables" in piece) {
				for (const character of String(piece.text)) {
					// Only a Han character names a file.
					if (/^\p{Script=Han}$/u.test(character)) {
						into.add(character);
					}
				}
			}
		}
	}
}

// The study files for a study file's text (one Study per line), by their path under the page's folder: one words
// file per entry (the study as it is), one file per character in use (its strokes and its Make Me a Hanzi row), and
// the licence files.
export function studyFiles(studyText: string): Map<string, string> {
	const files = new Map<string, string>();
	const characters = new Set<string>();
	for (const { id, study } of studiesIn(studyText)) {
		files.set(wordsPath(id), JSON.stringify(study));
		wordCharacters(study, characters);
	}
	for (const character of characters) {
		const row = dictionaryRow(character);
		const file: CharFile = {
			character: character,
			drawing: characterDrawing(character),
			dictionary: row,
			parts: characterParts(row),
		};
		files.set(charFilePath(character), JSON.stringify(file));
	}
	for (const [name, source] of Object.entries(STUDY_LICENCES)) {
		files.set(`${STUDY_FOLDER}/licences/${name}`, readFileSync(source, "utf8"));
	}
	return files;
}

// Build into a new folder beside the output folder, then swap it in: the earlier build moves aside and is removed
// only once the new one is in its place. If the swap fails, the earlier build goes back and the new one is removed.
// With a study file (one Study per line), the studied entries get their study files and a "study" in the index.
// Returns the line the script prints.
export function build(
	digestsFile: string,
	outputFolder: string,
	staging: StagingBuild | null = null,
	studyFile: string | null = null,
): string {
	if (staging !== null && !COMMIT_ID.test(staging.commit)) {
		throw new BuildFailure(
			`--staging takes a commit id (7 to 40 hex digits), not ${JSON.stringify(staging.commit)}`,
		);
	}
	let text: string;
	try {
		text = readFileSync(digestsFile, "utf8");
	} catch (error) {
		throw new BuildFailure(`can't read ${digestsFile} (${errorCode(error)})`);
	}
	let data: ReturnType<typeof siteData>;
	try {
		data = siteData(text);
	} catch (error) {
		if (error instanceof UnloadedLine) {
			throw new BuildFailure(
				`line ${error.line} of ${digestsFile} ${error.problem}`,
			);
		}
		throw error;
	}
	const selected = readSelected(digestsFile);
	for (const built of ["app.js", "sw.js"]) {
		if (!existsSync(join(SITE_FOLDER, built))) {
			throw new BuildFailure(
				`site/${built} doesn't exist: run pnpm run build first`,
			);
		}
	}
	let study: Map<string, string> | null = null;
	if (studyFile !== null) {
		let studyText: string;
		try {
			studyText = readFileSync(studyFile, "utf8");
		} catch (error) {
			throw new BuildFailure(`can't read ${studyFile} (${errorCode(error)})`);
		}
		study = studyFiles(studyText);
		// The index names the words file of each entry that has a study.
		for (const day of data.index.days) {
			for (const entry of day.entries) {
				const words = wordsPath(entry.id);
				if (study.has(words)) {
					entry.study = words;
				}
			}
		}
	}

	const target = resolve(outputFolder);
	const suffix = randomBytes(8).toString("hex");
	const fresh = join(dirname(target), `.${basename(target)}.${suffix}.new`);
	const old = join(dirname(target), `.${basename(target)}.${suffix}.old`);
	try {
		writeBuild(fresh, data, selected, staging, study);
	} catch (error) {
		rmSync(fresh, { recursive: true, force: true });
		throw new BuildFailure(`couldn't write the build (${errorCode(error)})`);
	}
	// The key Claude's replies are paid with lives in the Worker alone: a published file that holds one stops the build.
	const leaked = fileHoldingApiKey(fresh);
	if (leaked !== null) {
		rmSync(fresh, { recursive: true, force: true });
		throw new BuildFailure(`${leaked} holds an Anthropic API key`);
	}
	let movedAside = false;
	try {
		if (existsSync(target)) {
			renameSync(target, old);
			movedAside = true;
		}
		renameSync(fresh, target);
	} catch (error) {
		// Leave the output folder as it was: drop the new build and move the earlier one back.
		const failure = `couldn't move the build into ${outputFolder} (${errorCode(error)})`;
		rmSync(fresh, { recursive: true, force: true });
		if (movedAside) {
			try {
				renameSync(old, target);
			} catch (restoreError) {
				throw new BuildFailure(
					`${failure}, and couldn't move the earlier build back from ${old} (${errorCode(restoreError)})`,
				);
			}
		}
		throw new BuildFailure(failure);
	}
	rmSync(old, { recursive: true, force: true });
	let built = `built ${outputFolder}: ${data.index.days.length} days in ${data.months.size} month files`;
	if (study !== null) {
		const studied = data.index.days
			.flatMap((day) => day.entries)
			.filter((entry) => entry.study !== undefined);
		built += `, ${studied.length} studied entries`;
	}
	return built;
}

function main(args: string[]) {
	let staging: StagingBuild | null = null;
	let studyFile: string | null = null;
	let rest = args;
	// The options come first, in either order.
	while (rest[0] === "--staging" || rest[0] === "--study") {
		const value = rest[1];
		if (value === undefined) {
			break;
		}
		if (rest[0] === "--staging") {
			staging = { commit: value };
		} else {
			studyFile = value;
		}
		rest = rest.slice(2);
	}
	const digestsFile = rest[0];
	const outputFolder = rest[1];
	if (
		rest.length !== 2 ||
		digestsFile === undefined ||
		outputFolder === undefined
	) {
		console.error(
			"usage: node scripts/deploy/build-site.ts [--staging <commit>] [--study <study file>] <digests file> <output folder>",
		);
		process.exitCode = 1;
		return;
	}
	try {
		console.log(build(digestsFile, outputFolder, staging, studyFile));
	} catch (error) {
		if (!(error instanceof BuildFailure)) {
			throw error;
		}
		console.error(`build-site.ts: ${error.message}`);
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	main(process.argv.slice(2));
}
