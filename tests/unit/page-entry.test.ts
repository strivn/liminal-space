// @vitest-environment jsdom
// One entry drawn by renderEntry (site/page/entry.ts): the public page's text, and the owner's icon rail.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommentBoard } from "../../site/page/comment-board.ts";
import { startStatusRegion } from "../../site/page/dom.ts";
import { renderEntry } from "../../site/page/entry.ts";
import { createFeedbackBoard } from "../../site/page/feedback-board.ts";
import { createSender } from "../../site/page/owner.ts";
import { createReadBoard } from "../../site/page/read-board.ts";
import { createStandoutBoard } from "../../site/page/standout-board.ts";
import { createTagBoard } from "../../site/page/tag-board.ts";
import { createTakeawayBoard } from "../../site/page/takeaway-board.ts";
import type { Entry, ReadState } from "../../site/page/types.ts";
import { loadKatex, unloadKatex } from "./page-site.ts";

afterEach(() => {
	unloadKatex();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

// A paper with the fields every entry has; `extra` adds or replaces fields.
function paper(extra: Record<string, unknown> = {}): Entry {
	return {
		id: "arxiv:2601.00001",
		type: "paper",
		title: "A paper",
		...extra,
	};
}
function news(extra: Record<string, unknown> = {}): Entry {
	return { id: "news:fixture", type: "news", title: "A news item", ...extra };
}

// The entry drawn for the public page, in the document.
function drawn(entry: Entry) {
	const article = renderEntry(entry, null);
	document.body.append(article);
	return article;
}
const text = (root: ParentNode, selector: string) =>
	root.querySelector(selector)?.textContent ?? null;
const hrefs = (root: ParentNode) =>
	[...root.querySelectorAll("a")].map((link) => link.getAttribute("href"));

test("an entry shows its type, source and id on one meta line, with the authors and the date on lines of their own", () => {
	const article = drawn(
		paper({
			source: "arXiv Artificial Intelligence",
			authors: ["Ada Lovelace", "Alan Turing"],
			published: "2026-10-09",
			abstract: "The abstract.",
		}),
	);
	expect(text(article, ".entry__meta")).toBe(
		"paper · arXiv Artificial Intelligence · arxiv:2601.00001",
	);
	expect(text(article, ".entry__byline")).toBe("Ada Lovelace, Alan Turing");
	expect(text(article, ".entry__date")).toBe("9 October 2026");
	expect(text(article, ".entry__abstract")).toBe("The abstract.");
});

test("an entry without authors shows only the date line", () => {
	const article = drawn(news({ published: "2026-10-09" }));
	expect(article.querySelector(".entry__byline")).toBeNull();
	expect(text(article, ".entry__date")).toBe("9 October 2026");
});

test("a paper shows its journal reference and comments, between the date and the abstract", () => {
	const article = drawn(
		paper({
			published: "2026-10-09",
			journal_ref: "NeurIPS 2026",
			comment: "27 pages, 10 figures. Code: https://github.com/example/repo",
			abstract: "Abstract.",
		}),
	);
	const lines = [...article.querySelectorAll(".entry__body > *")].map(
		(node) => node.textContent,
	);
	expect(lines).toEqual([
		"A paper",
		"9 October 2026",
		"Journal reference: NeurIPS 2026",
		"Comments: 27 pages, 10 figures. Code: https://github.com/example/repo",
		"Abstract.",
	]);
	expect(
		hrefs(article.querySelectorAll(".entry__venue")[1] ?? article),
	).toEqual(["https://github.com/example/repo"]);
});

test("a paper without journal_ref or comment shows neither line", () => {
	const article = drawn(paper());
	expect(article.textContent).not.toContain("Journal reference:");
	expect(article.textContent).not.toContain("Comments:");
});

test("the surprise paper is marked, and the others are not", () => {
	const marked = drawn(paper({ pick: "surprise" }));
	expect(text(marked, ".entry__kicker")).toBe("Surprise");
	expect(
		drawn(paper({ id: "arxiv:2601.00002" })).querySelector(".entry__kicker"),
	).toBeNull();
});

test('an entry added ad hoc shows an "Ad hoc" badge on its meta line, and other entries do not', () => {
	expect(
		text(drawn(paper({ ad_hoc: true })), ".entry__meta .entry__origin"),
	).toBe("Ad hoc");
	expect(
		drawn(paper({ id: "arxiv:2601.00002", ad_hoc: false })).querySelector(
			".entry__origin",
		),
	).toBeNull();
});

test("a news item shows its publisher's description, and no caption names it", () => {
	const article = drawn(
		news({
			description:
				"Regulators publish the first draft of the code of practice.",
		}),
	);
	expect(text(article, ".entry__description")).toBe(
		"Regulators publish the first draft of the code of practice.",
	);
	expect(article.textContent).not.toContain("Publisher's description");
});

test('security: a figure or a Surprise pick inside an entry\'s "__proto__" field is ignored', () => {
	const entry = JSON.parse(
		'{"id": "arxiv:2601.00001", "type": "paper", "title": "A paper", "__proto__": {"figure": {"src": "https://arxiv.org/html/x/y.png"}, "pick": "surprise"}}',
	);
	const article = drawn(entry);
	expect(article.querySelector("figure")).toBeNull();
	expect(article.querySelector(".entry__kicker")).toBeNull();
});

test("security: a javascript: URL never becomes a link, and a javascript: extra link is not shown", () => {
	const article = drawn(
		news({
			url: "javascript:alert(1)",
			links: [{ label: "Extra", url: "javascript:alert(2)" }],
		}),
	);
	expect(article.querySelector(".entry__title a")).toBeNull();
	expect(article.querySelector(".entry__links")).toBeNull();
	for (const href of hrefs(article)) {
		expect(href).toMatch(/^https?:/);
	}
});

test("security: a javascript: URL that holds http:// further on never becomes a link", () => {
	const article = drawn(
		news({
			url: "javascript:alert(1)//http://example.com/",
			links: [{ label: "Extra", url: "javascript:alert(2)//https://x.org/" }],
		}),
	);
	expect(article.querySelector(".entry__title a")).toBeNull();
	expect(article.querySelector(".entry__links")).toBeNull();
	for (const href of hrefs(article)) {
		expect(href).toMatch(/^https?:/);
	}
});

test("the links row skips a link that is not an object or has no web address, and shows a number label as text", () => {
	const article = drawn(
		news({
			links: [
				null,
				"https://example.com/a",
				{ label: "Data", url: "ftp://example.com/b" },
				{ label: 7, url: "https://example.com/c" },
			],
		}),
	);
	expect(texts(article, ".entry__links a")).toEqual(["7"]);
});

function texts(root: ParentNode, selector: string) {
	return [...root.querySelectorAll(selector)].map((node) => node.textContent);
}

test("a paper's title opens its PDF and the PDF button is gone", () => {
	const article = drawn(
		paper({
			url: "https://arxiv.org/abs/2601.00001",
			links: [{ label: "PDF", url: "https://arxiv.org/pdf/2601.00001" }],
		}),
	);
	expect(
		article
			.querySelector(".entry__title > a:not(.entry__arxiv)")
			?.getAttribute("href"),
	).toBe("https://arxiv.org/pdf/2601.00001");
	expect(article.querySelector(".entry__links")).toBeNull();
});

test("the arXiv mark after the title opens the abstract page", () => {
	const article = drawn(
		paper({
			url: "https://arxiv.org/abs/2601.00001",
			links: [{ label: "PDF", url: "https://arxiv.org/pdf/2601.00001" }],
		}),
	);
	const mark = article.querySelector(".entry__title > .entry__arxiv");
	expect(mark?.getAttribute("href")).toBe("https://arxiv.org/abs/2601.00001");
	expect(mark?.getAttribute("aria-label")).toBe("arXiv abstract page");
	expect(mark?.querySelector("img")?.getAttribute("src")).toBe(
		"arxiv-logomark-small.svg",
	);
	// No text between the title's words and the mark, so the title text a comment anchors to is unchanged.
	expect(article.querySelector(".entry__title")?.textContent).toBe("A paper");
});

test("a paper without a PDF link keeps its title link and shows no arXiv mark", () => {
	const article = drawn(paper({ url: "https://arxiv.org/abs/2601.00002" }));
	expect(article.querySelector(".entry__title a")?.getAttribute("href")).toBe(
		"https://arxiv.org/abs/2601.00002",
	);
	expect(article.querySelector(".entry__arxiv")).toBeNull();
});

test("a paper from a conference site gets its PDF as the title link and no arXiv mark", () => {
	const article = drawn(
		paper({
			url: "https://www.usenix.org/paper",
			links: [{ label: "PDF", url: "https://www.usenix.org/paper.pdf" }],
		}),
	);
	expect(article.querySelector(".entry__arxiv")).toBeNull();
	expect(article.querySelector(".entry__title a")?.getAttribute("href")).toBe(
		"https://www.usenix.org/paper.pdf",
	);
});

test("news, articles and reports keep their title link and their PDF link, and show no arXiv mark", () => {
	const article = drawn(
		news({
			url: "https://example.com/news/1",
			links: [{ label: "PDF", url: "https://example.com/report.pdf" }],
		}),
	);
	expect(article.querySelector(".entry__title a")?.getAttribute("href")).toBe(
		"https://example.com/news/1",
	);
	expect(texts(article, ".entry__links a")).toEqual(["PDF"]);
	expect(article.querySelector(".entry__arxiv")).toBeNull();
});

test("a paper's links other than the PDF sit in the links row, and a paper with only a PDF link has no links row", () => {
	const withCode = drawn(
		paper({
			links: [
				{ label: "PDF", url: "https://arxiv.org/pdf/2601.00001" },
				{ label: "Code", url: "https://github.com/example/repo" },
			],
		}),
	);
	expect(texts(withCode, ".entry__links a")).toEqual(["Code"]);
	const alone = drawn(
		paper({
			id: "arxiv:2601.00002",
			links: [{ label: "PDF", url: "https://arxiv.org/pdf/2601.00002" }],
		}),
	);
	expect(alone.querySelector(".entry__links")).toBeNull();
});

test('a paper accepted at a venue shows "Accepted at" the venue, with a link to the page that says so', () => {
	const article = drawn(
		paper({
			venue: "AIES 2026",
			venue_source: "https://www.aies-conference.com/2026/paper-sessions/",
		}),
	);
	const line = article.querySelector(".entry__venue--accepted");
	expect(line?.textContent).toBe("Accepted at AIES 2026 · aies-conference.com");
	expect(line?.querySelector("a")?.getAttribute("href")).toBe(
		"https://www.aies-conference.com/2026/paper-sessions/",
	);
});

test("an acceptance found on the paper's first page names the paper's first page as its source", () => {
	const article = drawn(
		paper({
			venue: "ICML 2026",
			venue_source: "https://arxiv.org/pdf/2601.00001",
		}),
	);
	expect(text(article, ".entry__venue--accepted")).toBe(
		"Accepted at ICML 2026 · the paper's first page",
	);
});

test("security: a venue_source that isn't a web address shows no link, and a paper without a venue shows no acceptance line", () => {
	const bad = drawn(
		paper({ venue: "AIES 2026", venue_source: "javascript:alert(1)" }),
	);
	expect(text(bad, ".entry__venue--accepted")).toBe("Accepted at AIES 2026");
	expect(bad.querySelector(".entry__venue--accepted a")).toBeNull();
	const none = drawn(paper({ id: "arxiv:2601.00002" }));
	expect(none.textContent).not.toContain("Accepted at");
	const noAddress = drawn(
		paper({ id: "arxiv:2601.00003", venue: "X", venue_source: "http://" }),
	);
	expect(noAddress.querySelector(".entry__venue--accepted a")).toBeNull();
});

const FIGURE = {
	src: "https://arxiv.org/html/2601.00001v1/x1.png",
	caption: "Figure 1: Overview of the method.",
	from: "https://arxiv.org/html/2601.00001v1",
	width: 1200,
	height: 600,
};

test("a paper's Figure 1 shows after the abstract and before the links row, linked to its page, with its size set", () => {
	const article = drawn(
		paper({
			abstract: "Abstract.",
			figure: FIGURE,
			links: [{ label: "Code", url: "https://github.com/example/repo" }],
		}),
	);
	expect(
		[...article.querySelectorAll(".entry__body > *")].map(
			(node) => node.className,
		),
	).toEqual([
		"entry__title",
		"entry__abstract",
		"entry__figure",
		"entry__links",
	]);
	const image = article.querySelector("figure img");
	expect(image?.getAttribute("src")).toBe(FIGURE.src);
	expect(image?.getAttribute("width")).toBe("1200");
	expect(image?.getAttribute("height")).toBe("600");
	expect(article.querySelector("figure a")?.getAttribute("href")).toBe(
		FIGURE.from,
	);
	expect(text(article, "figcaption")).toBe("Figure 1: Overview of the method.");
});

test("a figure with an invalid width and height gets no size set, and a figure without a page address has no link", () => {
	const article = drawn(
		paper({ figure: { src: FIGURE.src, width: 0, height: "tall" } }),
	);
	const image = article.querySelector("figure img");
	expect(image?.hasAttribute("width")).toBe(false);
	expect(article.querySelector("figure a")).toBeNull();
	expect(article.querySelector("figcaption")).toBeNull();
});

test("math in a figure caption is typeset", () => {
	loadKatex();
	const article = drawn(
		paper({
			figure: {
				...FIGURE,
				caption: "Figure 1: Loss falls as $\\alpha$ grows.",
			},
		}),
	);
	expect(article.querySelector("figcaption .katex")).not.toBeNull();
	expect(text(article, "figcaption")).not.toContain("$");
});

test("a figure whose image doesn't load shows nothing, and the other entries still render", () => {
	const broken = drawn(paper({ figure: FIGURE }));
	const other = drawn(paper({ id: "arxiv:2601.00002" }));
	broken.querySelector("figure img")?.dispatchEvent(new Event("error"));
	expect(broken.querySelector("figure")).toBeNull();
	expect(broken.querySelector("figcaption")).toBeNull();
	expect(other.querySelector(".entry__title")).not.toBeNull();
});

for (const src of [
	"http://arxiv.org/html/2601.00001v1/x1.png",
	"https://arxiv.org.example.com/html/x1.png",
]) {
	test(`security: a figure src that isn't on arXiv's HTML site is ignored and never requested: ${src}`, () => {
		const article = drawn(paper({ figure: { ...FIGURE, src: src } }));
		expect(article.querySelector("figure")).toBeNull();
		expect(article.querySelector("img")).toBeNull();
	});
}

test("a news item never shows an arXiv figure", () => {
	expect(drawn(news({ figure: FIGURE })).querySelector("figure")).toBeNull();
});

test("security: a figure whose page address is not a web address shows the image with no link", () => {
	const article = drawn(
		paper({ figure: { ...FIGURE, from: "javascript:alert(1)" } }),
	);
	expect(article.querySelector("figure a")).toBeNull();
	expect(article.querySelector("figure img")).not.toBeNull();
});

test("math in a paper's title and abstract is typeset, and no dollar sign shows", () => {
	loadKatex();
	const article = drawn(
		paper({
			title: "Sorting in $O(n^2)$ time",
			abstract:
				"We show that $\\mathbb{E}[\\cos] \\approx (1+4/\\kappa)^{-1}$ holds when $\\kappa$ is large.",
		}),
	);
	expect(article.querySelector(".entry__title .katex")).not.toBeNull();
	expect(article.querySelector(".entry__abstract .katex")).not.toBeNull();
	expect(text(article, ".entry__title")).not.toContain("$");
	expect(article.querySelector(".entry__abstract .katex-error")).toBeNull();
});

test("dollar signs in news are left alone", () => {
	loadKatex();
	const article = drawn(
		news({ description: "Prices rose from $5 to $10 a month." }),
	);
	expect(text(article, ".entry__description")).toBe(
		"Prices rose from $5 to $10 a month.",
	);
	expect(article.querySelector(".katex")).toBeNull();
});

test("malformed TeX stays as written while the math after it still renders", () => {
	loadKatex();
	const article = drawn(
		paper({
			abstract:
				"We leave the bound $\\frac{1}$ open and prove $x^2 + y^2$ instead.",
		}),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.textContent).toContain("$\\frac{1}$");
	expect(abstract?.querySelectorAll(".katex")).toHaveLength(1);
	expect(abstract?.querySelector(".katex-error")).toBeNull();
});

test("an escaped \\$ in an abstract shows as a dollar sign, and the formulas around it still typeset", () => {
	loadKatex();
	const article = drawn(
		paper({
			abstract:
				"It costs only \\$1.7 and \\$0.3 per run, with $\\alpha$ and $x^2$ fixed.",
		}),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.querySelectorAll(".katex")).toHaveLength(2);
	expect(abstract?.querySelector(".katex-error")).toBeNull();
	expect(abstract?.textContent).toContain("only $1.7 and $0.3 per run");
	expect(abstract?.textContent).not.toContain("\\$");
});

test("an escaped \\%, \\&, \\# or \\_ in an abstract shows as the plain character, and a \\% inside math stays math", () => {
	loadKatex();
	const article = drawn(
		paper({
			abstract:
				"Recall rose from 42\\% to 63\\% on Who\\&When, run \\#3 of my\\_set, at $10\\%$ noise.",
		}),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.textContent).toContain(
		"from 42% to 63% on Who&When, run #3 of my_set, at",
	);
	expect(abstract?.querySelectorAll(".katex")).toHaveLength(1);
	expect(abstract?.querySelector(".katex-error")).toBeNull();
});

test("\\textsc in an abstract shows its words in small caps", () => {
	loadKatex();
	const article = drawn(
		paper({ abstract: "We introduce \\textsc{FavorBench}, a benchmark." }),
	);
	const smallCaps = article.querySelector(".entry__abstract .small-caps");
	expect(smallCaps?.textContent).toBe("FavorBench");
	expect(text(article, ".entry__abstract")).toBe(
		"We introduce FavorBench, a benchmark.",
	);
});

test("an author's macro that KaTeX lacks still renders", () => {
	loadKatex();
	const article = drawn(paper({ abstract: "an $\\eps$ is a claim" }));
	expect(text(article, ".entry__abstract .katex-html")).toBe("ε");
});

test("a huge TeX box in a title is drawn no larger than 5 em", () => {
	loadKatex();
	const article = drawn(
		paper({ title: "Bounds for $\\rule{1000em}{1000em}$ agents" }),
	);
	const box = article.querySelector<HTMLElement>(".katex .katex-rule");
	expect(box).not.toBeNull();
	expect(
		Number.parseFloat(box?.style.borderRightWidth ?? "0"),
	).toBeLessThanOrEqual(5);
	expect(
		Number.parseFloat(box?.style.borderTopWidth ?? "0"),
	).toBeLessThanOrEqual(5);
});

test("security: macros that expand without end stay as written, and the next entry still draws", () => {
	loadKatex();
	const hostile = drawn(
		paper({ abstract: "Growth $\\def\\a{\\a\\a}\\a$ unbounded" }),
	);
	const next = drawn(paper({ id: "arxiv:2601.00002", abstract: "Fine $x$." }));
	expect(text(hostile, ".entry__abstract")).toBe(
		"Growth $\\def\\a{\\a\\a}\\a$ unbounded",
	);
	expect(next.querySelector(".entry__abstract .katex")).not.toBeNull();
});

test("security: an HTML tag inside \\textit in an abstract shows as plain text in italics", () => {
	loadKatex();
	const article = drawn(
		paper({ abstract: "\\textit{<img src=x onerror=alert(1)>}" }),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.textContent).toBe("<img src=x onerror=alert(1)>");
	expect(abstract?.querySelector("img")).toBeNull();
	expect(abstract?.querySelector("i")).not.toBeNull();
});

test("security: \\includegraphics, \\htmlId and \\href inside an abstract's math are refused with no image, no id and no link drawn", () => {
	loadKatex();
	const article = drawn(
		paper({
			abstract:
				"See $\\includegraphics{https://tracker.example/pixel.png}$, $\\htmlId{planted}{x}$ and $\\href{javascript:alert(1)} {y}$.",
		}),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.querySelectorAll(".katex")).toHaveLength(3);
	expect(abstract?.querySelector("img, [id], a")).toBeNull();
});

test("a TeX link in an abstract, in math or in prose, becomes a link with its own words and no TeX error", () => {
	loadKatex();
	const inMath = drawn(
		paper({
			abstract:
				"data ($\\href{https://huggingface.co/datasets/a/b}{MultiTalkPT}$)",
		}),
	);
	const abstract = inMath.querySelector(".entry__abstract");
	expect(abstract?.textContent).toBe("data (MultiTalkPT)");
	expect(texts(abstract ?? inMath, "a")).toEqual(["MultiTalkPT"]);
	expect(hrefs(abstract ?? inMath)).toEqual([
		"https://huggingface.co/datasets/a/b",
	]);
	expect(abstract?.querySelector(".katex-error")).toBeNull();
	const inProse = drawn(
		paper({
			id: "arxiv:2601.00002",
			abstract: "in the \\href{https://github.com/a/b}{Molt library}.",
		}),
	);
	expect(text(inProse, ".entry__abstract")).toBe("in the Molt library.");
	expect(hrefs(inProse.querySelector(".entry__abstract") ?? inProse)).toEqual([
		"https://github.com/a/b",
	]);
});

test("a TeX link in a title becomes a link, and in a title that is already a link it shows as plain words", () => {
	loadKatex();
	const entry = paper({
		title: "The \\href{https://example.com/d}{Data} paper",
	});
	const article = drawn(entry);
	expect(text(article, ".entry__title")).toBe("The Data paper");
	expect(hrefs(article.querySelector(".entry__title") ?? article)).toEqual([
		"https://example.com/d",
	]);
	const withUrl = drawn({
		...entry,
		id: "arxiv:2601.00002",
		url: "https://arxiv.org/abs/2601.00002",
	});
	expect(text(withUrl, ".entry__title")).toBe("The Data paper");
});

for (const [field, build] of [
	["abstract", (value: string) => paper({ abstract: value })],
	["comment", (value: string) => paper({ comment: value })],
	["journal_ref", (value: string) => paper({ journal_ref: value })],
	[
		"figure caption",
		(value: string) => paper({ figure: { ...FIGURE, caption: value } }),
	],
	["description", (value: string) => news({ description: value })],
] as const) {
	test(`an address in the ${field} is a link, and the field's text is unchanged`, () => {
		const article = drawn(build("Code at https://github.com/example/repo now"));
		expect(
			hrefs(article).filter(
				(href) => href === "https://github.com/example/repo",
			),
		).toHaveLength(1);
		const link = [...article.querySelectorAll("a")].find(
			(one) => one.getAttribute("href") === "https://github.com/example/repo",
		);
		expect(link?.textContent).toBe("https://github.com/example/repo");
		expect(link?.getAttribute("draggable")).toBe("false");
		expect(link?.parentElement?.textContent).toContain(
			"Code at https://github.com/example/repo now",
		);
	});
}

test("an address in a title that isn't a link becomes one, and a title that is a link holds no second one", () => {
	const plain = drawn(news({ title: "Notes on https://example.com/notes" }));
	expect(hrefs(plain.querySelector(".entry__title") ?? plain)).toEqual([
		"https://example.com/notes",
	]);
	const linked = drawn(
		news({
			id: "news:other",
			url: "https://example.com/a",
			title: "See https://example.com/b",
		}),
	);
	expect(hrefs(linked.querySelector(".entry__title") ?? linked)).toEqual([
		"https://example.com/a",
	]);
});

test("an address next to typeset math is still a link", () => {
	loadKatex();
	const article = drawn(
		paper({ abstract: "We bound $\\alpha$ at https://example.com/proof." }),
	);
	const abstract = article.querySelector(".entry__abstract");
	expect(abstract?.querySelector(".katex")).not.toBeNull();
	expect(hrefs(abstract ?? article)).toEqual(["https://example.com/proof"]);
});

// ---- The owner's icon rail ----

// The real boards over one read state, as render.ts wires them, with the site answering 200 to every change.
function ownerEntry(entry: Entry) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
	startStatusRegion();
	const readState: ReadState = Object.create(null);
	const sender = createSender();
	const notice = () => {};
	const toggleViews: (() => void)[] = [];
	const readBoard = createReadBoard(
		readState,
		sender,
		notice,
		() => {
			for (const showPressed of toggleViews) showPressed();
		},
		() => {},
	);
	const article = renderEntry(entry, {
		readState: readState,
		onReadChange: (one, depth) => readBoard.press(one.id, depth),
		toggleViews: toggleViews,
		board: createCommentBoard({}, sender, notice, async () => true),
		tagBoard: createTagBoard(Object.create(null), sender, notice, () => {}),
		feedbackBoard: createFeedbackBoard(Object.create(null), sender, notice),
		standoutBoard: createStandoutBoard(Object.create(null), sender, notice),
		takeawayBoard: createTakeawayBoard(Object.create(null), sender),
	});
	document.body.append(article);
	return article;
}

const railNames = (article: Element, column: number) =>
	[
		...(
			article.querySelectorAll(".entry__rail-col")[column] ?? article
		).querySelectorAll("button[aria-label], a[aria-label]"),
	].map((control) => control.getAttribute("aria-label"));

test("a paper's rail holds its buttons in two columns, in the order a keyboard visits them", () => {
	const article = ownerEntry(paper());
	expect(railNames(article, 0)).toEqual([
		"Comment",
		"Copy",
		"Abstract",
		"Paper",
		"OK",
		"Like",
		"Dislike",
		"Select",
	]);
	expect(railNames(article, 1)).toEqual([
		"Discuss",
		"Talk about it",
		"Takeaway",
		"To read",
		"Learn first",
	]);
	expect(article.querySelectorAll("[aria-pressed='true']")).toHaveLength(0);
});

test("a news item, an article and a report have no Abstract or Paper read button", () => {
	for (const type of ["news", "article", "report"]) {
		const article = ownerEntry({ id: `${type}:x`, type: type, title: "T" });
		expect(railNames(article, 0)).not.toContain("Abstract");
		expect(railNames(article, 0)).not.toContain("Paper");
		expect(railNames(article, 0)).toContain("Like");
		article.remove();
	}
});

test("every rail button shows an icon and no visible text, and its tooltip is its name", () => {
	const article = ownerEntry(paper());
	for (const control of article.querySelectorAll(
		".entry__rail button[aria-label], .entry__rail a[aria-label]",
	)) {
		const name = control.getAttribute("aria-label");
		expect(control.getAttribute("title")).toBe(name);
		expect(control.querySelector("svg")).not.toBeNull();
		expect(
			control.querySelector(".rail-label")?.getAttribute("aria-hidden"),
		).toBe("true");
	}
	expect(article.textContent).not.toContain("Read:");
	expect(article.textContent).not.toContain("Next:");
});

test("security: Discuss and Talk about it open a new tab that cannot reach back into the page", () => {
	const article = ownerEntry(paper());
	for (const name of ["Discuss", "Talk about it"]) {
		const link = article.querySelector(`[aria-label="${name}"]`);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
	}
});

// Copy puts the entry's reference on the clipboard and says so for two seconds; a refusal says so and stays.
describe("Copy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	function clipboard(write: (text: string) => Promise<void>) {
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(write) } });
	}
	const flush = () => vi.advanceTimersByTimeAsync(0);
	const copy = (article: Element) =>
		article.querySelector<HTMLButtonElement>('[aria-label^="Cop"]');

	test("Copy puts the reference on the clipboard, shows Copied, and shows Copy again 2 seconds later", async () => {
		clipboard(async () => {});
		const article = ownerEntry(
			paper({
				title: "Chain of Thought",
				url: "https://arxiv.org/abs/2507.11473",
			}),
		);
		copy(article)?.click();
		await flush();
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			"Chain of Thought; ID/DOI: arxiv:2601.00001; URL: https://arxiv.org/abs/2507.11473",
		);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copied");
		expect(copy(article)?.querySelector("svg")?.getAttribute("data-icon")).toBe(
			"check",
		);
		expect(document.querySelector("[role=status]")?.textContent).toBe("Copied");
		await vi.advanceTimersByTimeAsync(1999);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copied");
		await vi.advanceTimersByTimeAsync(2);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copy");
		expect(document.querySelector("[role=status]")?.textContent).toBe("");
	});

	test("a clipboard the browser refuses shows Copy failed, and it stays", async () => {
		clipboard(async () => {
			throw new DOMException("denied", "NotAllowedError");
		});
		const article = ownerEntry(paper());
		copy(article)?.click();
		await flush();
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copy failed");
		expect(document.querySelector("[role=status]")?.textContent).toBe(
			"Copy failed",
		);
		await vi.advanceTimersByTimeAsync(5000);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copy failed");
	});

	test("Copying twice keeps Copied for 2 seconds after the second click", async () => {
		clipboard(async () => {});
		const article = ownerEntry(paper());
		copy(article)?.click();
		await flush();
		await vi.advanceTimersByTimeAsync(1500);
		copy(article)?.click();
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copied");
		await vi.advanceTimersByTimeAsync(1100);
		expect(copy(article)?.getAttribute("aria-label")).toBe("Copy");
	});

	test("privacy: the copied reference and the Discuss link carry no tags", async () => {
		clipboard(async () => {});
		const article = ownerEntry(paper());
		article.querySelector<HTMLButtonElement>('[aria-label="To read"]')?.click();
		article
			.querySelector<HTMLButtonElement>('[aria-label="Learn first"]')
			?.click();
		copy(article)?.click();
		await flush();
		const discuss =
			article.querySelector('[aria-label="Discuss"]')?.getAttribute("href") ??
			"";
		const copied =
			vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? "";
		for (const carried of [copied, decodeURIComponent(discuss)])
			expect(carried).not.toMatch(/To read|Learn first|toRead|learnFirst/);
		expect(
			article
				.querySelector('[aria-label="To read"]')
				?.getAttribute("aria-pressed"),
		).toBe("true");
	});
});

test("a news entry's line shows its link's host after the source", () => {
	const line = (extra: Record<string, unknown>) =>
		text(drawn(news(extra)), ".entry__meta");
	const url = "https://www.example.com/story";
	expect(line({ source: "Example Daily", url })).toBe(
		"news · Example Daily · example.com",
	);
	expect(line({ source: "example.com", url })).toBe("news · example.com");
	expect(line({ type: "report", source: "A Lab", url })).toBe(
		"report · A Lab · example.com",
	);
});

test("a paper's line shows no host", () => {
	const article = drawn(
		paper({
			source: "arXiv Artificial Intelligence",
			url: "https://arxiv.org/abs/2601.00001",
		}),
	);
	expect(text(article, ".entry__meta")).toBe(
		"paper · arXiv Artificial Intelligence · arxiv:2601.00001",
	);
});

test("security: a data: or vbscript: URL never becomes a link, in the title or the links row", () => {
	for (const url of [
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
	]) {
		const article = drawn(news({ url, links: [{ label: "Extra", url }] }));
		expect(article.querySelector(".entry__title a")).toBeNull();
		expect(article.querySelector(".entry__links")).toBeNull();
		for (const href of hrefs(article)) {
			expect(href).toMatch(/^https?:/);
		}
	}
});

const LAB_POST =
	"https://openai.com/index/combatting-adversarial-distillation/";
const LAB_FIGURE = {
	src: "https://images.ctfassets.net/kftzwdyauwt9/v3S/d0a/diagram.png",
	from: LAB_POST,
	alt: "Two layers of anti-distillation safeguards.",
	caption: "Figure 1: Model behaviour and API protections cost $5.",
};
function labPost(figure: Record<string, unknown> = LAB_FIGURE) {
	return news({
		url: LAB_POST,
		description: "How we protect our models from distillation.",
		figure: figure,
	});
}

test("A lab post's figure shows after its description, linked to the post", () => {
	const article = drawn(labPost());
	const body = article.querySelector(".entry__body");
	const parts = [...(body?.children ?? [])].map((part) => part.className);
	expect(parts.indexOf("entry__figure")).toBe(
		parts.indexOf("entry__description") + 1,
	);
	expect(article.querySelector("figure a")?.getAttribute("href")).toBe(
		LAB_POST,
	);
});

test("A lab post's figure carries the lab's alt text, and the lab's caption when there is one", () => {
	const article = drawn(labPost());
	expect(article.querySelector("figure img")?.getAttribute("alt")).toBe(
		LAB_FIGURE.alt,
	);
	expect(text(article, "figcaption")).toBe(LAB_FIGURE.caption);
	const bare = drawn(labPost({ src: LAB_FIGURE.src, from: LAB_POST }));
	expect(bare.querySelector("figure img")?.getAttribute("alt")).toBe("Figure");
	expect(bare.querySelector("figcaption")).toBeNull();
});

test("A lab post's figure is requested with no referrer", () => {
	const image = drawn(labPost()).querySelector("figure img");
	expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("security: a lab post's figure from an address outside its lab is never requested", () => {
	for (const src of [
		"https://images.ctfassets.net/otherspace/x.png",
		"https://assets.claude.com/9072701b.jpg",
		"http://images.ctfassets.net/kftzwdyauwt9/x.png",
	]) {
		const article = drawn(labPost({ ...LAB_FIGURE, src: src }));
		expect(article.querySelector("figure")).toBeNull();
		expect(article.querySelector(`img[src="${src}"]`)).toBeNull();
	}
	const unlisted = drawn(
		news({ url: "https://blog.redwoodresearch.org/p/x", figure: LAB_FIGURE }),
	);
	expect(unlisted.querySelector("figure")).toBeNull();
	expect(unlisted.querySelector(`img[src="${LAB_FIGURE.src}"]`)).toBeNull();
});

test("A lab post's figure that fails to load leaves no broken image", () => {
	const article = drawn(labPost());
	article.querySelector("figure img")?.dispatchEvent(new Event("error"));
	expect(article.querySelector("figure")).toBeNull();
	expect(text(article, ".entry__description")).toBe(
		"How we protect our models from distillation.",
	);
});

const ARXIV_PAPER = {
	url: "https://arxiv.org/abs/1706.03762",
	links: [{ label: "PDF", url: "https://arxiv.org/pdf/1706.03762" }],
};
const PUBLISHED = {
	url: "https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
	venue: "NeurIPS 2017",
	from: "https://proceedings.neurips.cc/paper_files/paper/2017",
};
const titleHref = (article: Element) =>
	article.querySelector(".entry__title > a")?.getAttribute("href");

test("A paper's title opens its published version when it has one, and its arXiv page otherwise", () => {
	expect(
		titleHref(drawn(paper({ ...ARXIV_PAPER, camera_ready: PUBLISHED }))),
	).toBe(PUBLISHED.url);
	expect(titleHref(drawn(paper(ARXIV_PAPER)))).toBe(
		"https://arxiv.org/pdf/1706.03762",
	);
});

test("A paper with a published version still links to its arXiv page", () => {
	const article = drawn(paper({ ...ARXIV_PAPER, camera_ready: PUBLISHED }));
	const links = hrefs(article);
	expect(links).toContain("https://arxiv.org/abs/1706.03762");
	expect(links).toContain("https://arxiv.org/pdf/1706.03762");
});

test("security: a published version that is not https is never linked", () => {
	for (const url of [
		"http://proceedings.neurips.cc/paper.html",
		"javascript:alert(1)",
	]) {
		const article = drawn(
			paper({ ...ARXIV_PAPER, camera_ready: { ...PUBLISHED, url: url } }),
		);
		expect(hrefs(article)).not.toContain(url);
		expect(titleHref(article)).toBe("https://arxiv.org/pdf/1706.03762");
	}
});
