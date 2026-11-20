// The day's arXiv HTML pages, shared by first-page.ts and figure.ts: one fetch serves both, and each GET costs
// arXiv's 15-second crawl delay.
// Pages live in <ARXIV_HTML_STORE or the system temp folder>/liminal-arxiv-html/<id>.json (an old-style id's "/" as
// "_"): nothing in the repo or the cache folder.
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorCode, isJsonObject } from "../../../shared/narrow.ts";

// A copy is used for this long after it was stored; an older one is fetched again and replaced.
export const STORED_PAGE_MS = 24 * 3600 * 1000;

// One stored page: the HTTP status (200, or 404 when arXiv has no HTML version), the URL the answer came from (after
// redirects), the page's text (empty for a 404), and when it was stored, as an ISO time.
export type StoredPage = {
	status: number;
	finalUrl: string;
	text: string;
	storedAt: string;
};

// The folder the copies live in: ARXIV_HTML_STORE when set (scenarios point it at a folder of their own), else
// liminal-arxiv-html in the system temp folder.
export function storeFolder(): string {
	const base = process.env.ARXIV_HTML_STORE || tmpdir();
	return join(base, "liminal-arxiv-html");
}

// The page stored for `id` (normalizeId form) when it is less than STORED_PAGE_MS old at `now`; null when there is
// none, it is older, or its file doesn't load. An old or unreadable file is removed.
export function readStoredPage(
	id: string,
	now = Date.now(),
): StoredPage | null {
	const file = storeFile(id);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null; // no copy, or one that can't be read
	}
	const page = parsePage(text);
	// A copy that doesn't load, or an old one: fetched again, so the file only takes up space.
	if (page === null || !isFresh(page.storedAt, now)) {
		remove(file);
		return null;
	}
	return page;
}

// Remove a file of the store when it is there. force ignores a file that is already gone; any other failure (a
// folder the script can't write to) is ignored too: the file is not used either way, and the page is fetched again.
function remove(file: string) {
	try {
		rmSync(file, { force: true });
	} catch {
		// left in place
	}
}

// The file the copy of `id`'s page lives in: an old-style id's "/" (hep-th/9711200) becomes "_" to stay one name.
function storeFile(id: string) {
	return join(storeFolder(), `${id.replaceAll("/", "_")}.json`);
}

// The StoredPage a file's text holds, or null when it isn't one.
function parsePage(text: string): StoredPage | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		!isJsonObject(data) ||
		typeof data.status !== "number" ||
		typeof data.finalUrl !== "string" ||
		typeof data.text !== "string" ||
		typeof data.storedAt !== "string"
	) {
		return null;
	}
	return {
		status: data.status,
		finalUrl: data.finalUrl,
		text: data.text,
		storedAt: data.storedAt,
	};
}

// Whether a page stored at `storedAt` (an ISO time) is still used at `now`: less than STORED_PAGE_MS old. A time
// that doesn't parse is not fresh.
function isFresh(storedAt: string, now: number) {
	const stored = Date.parse(storedAt);
	if (Number.isNaN(stored)) {
		return false;
	}
	return now - stored < STORED_PAGE_MS;
}

// Keep `page` for `id`, making the folder as needed and writing through a temporary file and a rename, so a reader
// never sees a half-written copy. A failure to write is not a failure of the script: the page was fetched.
export function storePage(id: string, page: StoredPage): void {
	const file = storeFile(id);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(storeFolder(), { recursive: true });
		writeFileSync(temporary, JSON.stringify(page));
		renameSync(temporary, file);
	} catch (error) {
		// The temporary file, when it got written. Removing it can fail the way the write did (ENOTDIR when the base
		// is a file), so remove() swallows that: the failure is reported once, below.
		remove(temporary);
		console.error(
			`arxiv-html-store: could not keep ${id} (${errorCode(error)})`,
		);
	}
}
