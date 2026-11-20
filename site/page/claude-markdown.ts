// Claude's reply drawn from Markdown: marked turns it into HTML, DOMPurify keeps only
// the allowed tags, and math is left as written for typeset() to draw.
import DOMPurify from "dompurify";
import type { TokenizerAndRendererExtension } from "marked";
import { Marked } from "marked";
import { safeUrl } from "./text.ts";

const ALLOWED_TAGS = [
	"p",
	"br",
	"strong",
	"em",
	"code",
	"pre",
	"ul",
	"ol",
	"li",
	"blockquote",
	"a",
];

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

// $$...$$ and $...$ stay as written, so "_" and "*" inside math are not read as emphasis. A single $ opens math only
// before a non-space and closes it after one, so "costs $5 and $6" stays prose.
const MATH_PATTERN = /^\$\$[\s\S]+?\$\$|^\$(?!\s)(?:\\.|[^$\\\n])+?(?<!\s)\$/;
const math: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start: (source) => source.indexOf("$"),
	tokenizer(source) {
		const found = MATH_PATTERN.exec(source);
		if (found === null) return undefined;
		return { type: "math", raw: found[0], text: found[0] };
	},
	renderer: (token) => escapeHtml(token.text),
};

// Raw HTML in a reply is text, and an image is nothing: the page draws no picture a model chose.
const markdown = new Marked({
	extensions: [math],
	renderer: {
		html: (token) => escapeHtml(token.text),
		image: () => "",
	},
});

// The reply as page nodes: paragraphs, bold, italics, code, lists, quotes and http(s) links; nothing else.
export function renderClaudeMarkdown(text: string): DocumentFragment {
	const html = markdown.parse(text, { async: false });
	const fragment = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ALLOWED_TAGS,
		ALLOWED_ATTR: ["href"],
		ALLOWED_URI_REGEXP: /^https?:/i,
		RETURN_DOM_FRAGMENT: true,
	});
	for (const link of fragment.querySelectorAll("a")) {
		if (safeUrl(link.getAttribute("href")) === null) {
			link.replaceWith(...link.childNodes);
			continue;
		}
		link.setAttribute("rel", "noopener noreferrer");
		link.classList.add("text-link");
		link.draggable = false;
	}
	return fragment;
}
