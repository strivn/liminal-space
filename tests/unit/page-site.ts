// A stand-in site for the page's whole start(): index.html's body, data files answered from memory, jsdom's gaps filled.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import type { IndexDay, SiteIndex } from "../../shared/site-data-shape.ts";
import { start } from "../../site/page/render.ts";

const INDEX_HTML = readFileSync(
	resolve(process.cwd(), "site/index.html"),
	"utf8",
);

// What the stand-in site holds: the index, files by path under the page's folder, the owner's state, the text a path
// answers with instead of JSON, the status a path answers with instead of 200, and every path asked for.
export type FakeSite = {
	index: unknown;
	files: Record<string, unknown>;
	owner?: unknown;
	raw: Record<string, string>;
	statuses: Record<string, number>;
	requested: string[];
	posts: { path: string; body: unknown }[];
};

type Entry = Record<string, unknown> & { id: string; type: string };

export function paperEntry(id: string, title: string, extra = {}): Entry {
	return { id: `arxiv:${id}`, type: "paper", title: title, ...extra };
}
export function newsEntry(id: string, title: string, extra = {}): Entry {
	return { id: `news:${id}`, type: "news", title: title, ...extra };
}

// A site from lines of [date, entries]: the index lists each day's entries, and each month has one file with its lines.
export function siteOf(lines: { date: string; entries: Entry[] }[]): FakeSite {
	const days: IndexDay[] = [];
	const months: Record<string, string> = {};
	const files: Record<string, unknown> = {};
	const sorted = [...lines].sort((a, b) => b.date.localeCompare(a.date));
	for (const line of sorted) {
		const month = line.date.slice(0, 7);
		days.push({
			date: line.date,
			month: month,
			entries: line.entries.map((entry) => ({
				id: entry.id,
				type: entry.type,
			})),
		});
		months[month] = `months/${month}.json`;
		const file = files[`data/months/${month}.json`] as
			| {
					lines: unknown[];
			  }
			| undefined;
		if (file === undefined)
			files[`data/months/${month}.json`] = { lines: [line] };
		else file.lines.push(line);
	}
	// The search file: each entry with no topic or keywords, unless a test writes its own.
	files["data/search.json"] = {
		entries: lines.flatMap((line) =>
			line.entries.map((entry) => ({
				id: entry.id,
				date: line.date,
				type: entry.type,
				topic: null,
				keywords: [],
				venue: typeof entry.venue === "string" ? entry.venue : null,
			})),
		),
	};
	const index: SiteIndex = { days: days, months: months };
	return {
		index: index,
		files: files,
		raw: {},
		statuses: {},
		requested: [],
		posts: [],
	};
}

// Answer every fetch from the site: the index, month files, the owner's state, and a 200 to every change.
function serve(site: FakeSite) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
			const clean = path.replace(/^\.\.\//, "");
			if (init?.method === "POST") {
				site.posts.push({ path: clean, body: JSON.parse(init.body ?? "null") });
				return new Response("{}", { status: site.statuses[clean] ?? 200 });
			}
			site.requested.push(clean);
			const status = site.statuses[clean];
			if (status !== undefined && status !== 200)
				return new Response("", { status: status });
			const raw = site.raw[clean];
			if (raw !== undefined) return new Response(raw, { status: 200 });
			if (clean === "data/index.json") {
				if (site.index === undefined) return new Response("", { status: 404 });
				return Response.json(site.index);
			}
			if (clean === "api/owner/state") {
				if (site.owner === undefined) return new Response("", { status: 403 });
				return Response.json(site.owner);
			}
			const file = site.files[clean];
			if (file === undefined) return new Response("", { status: 404 });
			return Response.json(file);
		}),
	);
}

// jsdom has no layout, scrolling or media queries; these answer as a window with a mouse.
export function stubBrowser(wide = false) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: wide && query.includes("min-width"),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.stubGlobal("visualViewport", null);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Element.prototype.scrollIntoView = () => {};
	Object.defineProperty(document, "fonts", {
		value: { ready: Promise.resolve() },
		configurable: true,
	});
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
		this.dispatchEvent(new Event("close"));
	};
}

// The page's own copy of KaTeX and its auto-render, as index.html loads them, so math is typeset as in the browser.
export function loadKatex() {
	for (const file of ["katex.min.js", "auto-render.min.js"]) {
		const code = readFileSync(
			resolve(process.cwd(), "site/katex", file),
			"utf8",
		);
		new Function(code).call(globalThis);
	}
}

// Take KaTeX out again, so a later test sees a page whose math script failed to load.
export function unloadKatex() {
	Reflect.deleteProperty(globalThis, "katex");
	Reflect.deleteProperty(globalThis, "renderMathInElement");
}

// The listeners a drawn page put on the document and the window, which outlive its elements.
const pageListeners: [
	EventTarget,
	string,
	EventListenerOrEventListenerObject,
	boolean | AddEventListenerOptions | undefined,
][] = [];

// The document's and the window's own addEventListener, kept before the first spy replaces it.
const realAdd = new Map<EventTarget, EventTarget["addEventListener"]>();

// Remove the listeners the page added, so a page from an earlier test no longer answers keys, scrolls and hash changes.
export function releasePage() {
	for (const [target, type, listener, options] of pageListeners.splice(0))
		target.removeEventListener(type, listener, options);
}

function recordListeners() {
	for (const target of [document, window]) {
		let add = realAdd.get(target);
		if (add === undefined) {
			add = target.addEventListener;
			realAdd.set(target, add);
		}
		const original = add;
		vi.spyOn(target, "addEventListener").mockImplementation(
			(type, listener, options) => {
				if (listener !== null)
					pageListeners.push([target, type, listener, options]);
				original.call(target, type, listener, options);
			},
		);
	}
}

// index.html's body in the document, the address of the public page or the owner's, then the page's start().
export async function openPage(
	site: FakeSite,
	options: { owner?: boolean; hash?: string; narrow?: boolean } = {},
) {
	const body = INDEX_HTML.slice(
		INDEX_HTML.indexOf("<body>") + 6,
		INDEX_HTML.indexOf("<script"),
	);
	document.body.innerHTML = body;
	const path = options.owner ? "/liminal-space/owner/" : "/liminal-space/";
	history.replaceState(null, "", `${path}${options.hash ?? ""}`);
	stubBrowser(options.narrow !== true);
	serve(site);
	recordListeners();
	await start();
}

// The text of the elements `selector` matches.
export function texts(selector: string) {
	return [...document.querySelectorAll(selector)].map((node) =>
		(node.textContent ?? "").trim(),
	);
}

// The titles of the entries the page shows now: not hidden by the Search sentence, not in a hidden or folded day.
export function shownTitles() {
	return [...document.querySelectorAll<HTMLElement>("main article")]
		.filter(
			(one) => !one.hidden && !one.closest("[hidden], details:not([open])"),
		)
		.map((one) => one.querySelector(".entry__title")?.textContent);
}

// The titles the contents list now, less the ones the Search sentence hid.
export function listedTitles() {
	return [...document.querySelectorAll<HTMLElement>(".contents li:not([role])")]
		.filter((one) => !one.closest("[hidden]"))
		.map((one) => one.textContent);
}
