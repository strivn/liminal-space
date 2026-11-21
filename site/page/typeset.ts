// Typeset math and links in text: KaTeX's auto-render, TeX links and prose commands, and web addresses turned into links.
import { el } from "./dom.ts";
import {
	escapePercent,
	linkPieces,
	literalPieces,
	MATH_DELIMITERS,
	type MathDelimiter,
	type ProseNode,
	proseNodes,
	safeUrl,
	texLinkPieces,
} from "./text.ts";

// The auto-render options the page sets: preProcess rewrites each math span before KaTeX reads it; maxSize (in em)
// caps every size the TeX names, maxExpand the number of macro expansions in one span.
type MathOptions = {
	delimiters: MathDelimiter[];
	ignoredClasses: string[];
	preProcess: (math: string) => string;
	macros: Record<string, string>;
	maxSize: number;
	maxExpand: number;
};
// KaTeX's auto-render, from katex/auto-render.min.js; missing when that file failed to load.
declare const renderMathInElement:
	| ((element: HTMLElement, options: MathOptions) => void)
	| undefined;

// Macros authors define in their own papers that KaTeX lacks, as their sources define them (arxiv:2610.21245).
const AUTHOR_MACROS: Record<string, string> = { "\\eps": "\\varepsilon" };

// Entry text comes from arXiv and publishers' pages, so its TeX may be careless or hostile: a box, rule or space
// larger than 5 em is drawn 5 em, and a span whose macros expand more than 1000 times (KaTeX's
// default, kept on purpose) stays as written.
const TEX_LITERAL = "tex-literal";
const MAX_SIZE_EM = 5;
const MAX_EXPAND = 1000;

// Format prose before math splits its text nodes; unsupported commands and unparseable math stay literal.
export function typeset(node: HTMLElement): void {
	texLinks(node);
	for (const text of textNodesOutside(node, ".katex, code")) {
		if (/\\(?:textit|emph|textbf|texttt|textsc)\s*\{/.test(text.data))
			text.replaceWith(proseFragment(text.data));
	}
	for (const text of textNodesOutside(node, ".katex, code")) {
		if (!/\\[$%&#_]/.test(text.data)) continue;
		text.replaceWith(
			...literalPieces(text.data).map((piece) =>
				typeof piece === "string"
					? piece
					: el("span", { class: TEX_LITERAL }, piece.literal),
			),
		);
	}
	if (typeof renderMathInElement === "function")
		renderMathInElement(node, {
			delimiters: MATH_DELIMITERS,
			ignoredClasses: [TEX_LITERAL],
			preProcess: escapePercent,
			macros: AUTHOR_MACROS,
			maxSize: MAX_SIZE_EM,
			maxExpand: MAX_EXPAND,
		});
}

// KaTeX draws \href and \url as an error unless it trusts them, so the links the authors wrote in TeX become the
// page's own links before KaTeX runs. Inside a link already (the contents, the shelf) only their words stay.
function texLinks(element: HTMLElement) {
	for (const node of textNodesOutside(element, ".katex, code")) {
		if (!/\\(?:href|url)\{/.test(node.data)) continue;
		const insideLink = node.parentElement?.closest("a") != null;
		node.replaceWith(
			...texLinkPieces(node.data).map((piece) => {
				if (piece.href === undefined || insideLink) return piece.text;
				return textLink(piece.text, piece.href);
			}),
		);
	}
}

// The prose nodes as DOM: text, and an element for each prose command.
function proseFragment(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	fragment.append(...proseNodes(text, 0).map(proseDom));
	return fragment;
}

function proseDom(node: ProseNode): Node | string {
	if (typeof node === "string") return node;
	const attrs = node.class === undefined ? null : { class: node.class };
	return el(node.tag, attrs, ...node.children.map(proseDom));
}

// The text nodes inside `element`, in page order, less those inside an element `skip` matches, such as typeset math
// (".katex"). The walk is finished before the list comes back, so a caller may replace the nodes: replacing one while
// walking would lose the walker's place.
export function textNodesOutside(element: Element, skip: string): Text[] {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!(node instanceof Text)) continue;
		const parent = node.parentElement;
		if (parent && parent.closest(skip)) continue;
		nodes.push(node);
	}
	return nodes;
}

// Turn the web addresses and DOIs in an element's text into links (a.text-link), leaving its text as it was, which
// comments anchor to: each text node outside typeset math and outside a link is cut into linkPieces' pieces. Only an
// address safeUrl lets through becomes a link. draggable="false" with style.css's user-select lets a mouse drag that
// starts on a link select text, as in a title.
export function linkAddresses(element: HTMLElement) {
	for (const node of textNodesOutside(element, ".katex, a")) {
		const pieces = linkPieces(node.data);
		if (!pieces.some((piece) => piece.href !== undefined)) continue;
		const replacements = pieces.map((piece) => {
			const href = safeUrl(piece.href);
			if (href === null) return piece.text;
			return textLink(piece.text, href);
		});
		node.replaceWith(...replacements);
	}
}

// A link the page makes from text: a.text-link, not draggable.
function textLink(words: string, href: string) {
	return el("a", { class: "text-link", href: href, draggable: "false" }, words);
}
