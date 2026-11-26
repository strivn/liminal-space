// A paper's OpenAlex topic and keywords under its abstract, each a button that adds itself to the Search sentence.
import { isJsonObject } from "../../shared/narrow.ts";
import { OPENALEX_CAPS } from "../../shared/openalex.ts";
import { el } from "./dom.ts";
import type { Entry } from "./types.ts";

// How many of a paper's keywords are listed.
const KEYWORDS_SHOWN = 5;

function isText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= OPENALEX_CAPS.text
	);
}

// The main topic's name, or null when OpenAlex has not classified the paper yet, and the keywords as OpenAlex gave them.
function openAlexOf(value: unknown): {
	topic: string | null;
	keywords: string[];
} {
	if (!isJsonObject(value)) return { topic: null, keywords: [] };
	const first: unknown = Array.isArray(value.topics) ? value.topics[0] : null;
	const topic = isJsonObject(first) && isText(first.name) ? first.name : null;
	const listed: unknown[] = Array.isArray(value.keywords) ? value.keywords : [];
	return { topic: topic, keywords: listed.filter(isText) };
}

// One topic or keyword as a button; `subject` is how the Search sentence names it ("t:<topic>" or "k:<keyword>").
function subjectButton(subject: string, name: string) {
	return el(
		"button",
		{
			type: "button",
			class: "entry__subject",
			"data-subject": subject,
			"aria-pressed": "false",
		},
		name,
	);
}

// "Topics (OpenAlex): <main topic>" and, on the next line, "Keywords (OpenAlex): <up to 5>"; null for what is not a
// paper. A paper OpenAlex has not classified yet reads "none yet", and has no keywords line.
export function openAlexLines(entry: Entry): HTMLElement | null {
	if (entry.type !== "paper") return null;
	const { topic, keywords } = openAlexOf(entry.openalex);
	const lines = [
		el(
			"p",
			null,
			"Topics (OpenAlex): ",
			topic === null ? "none yet" : subjectButton(`t:${topic}`, topic),
		),
	];
	const listed = keywords.slice(0, KEYWORDS_SHOWN);
	if (listed.length > 0) {
		const names: (Node | string)[] = [];
		listed.forEach((keyword, at) => {
			if (at > 0) names.push(", ");
			names.push(subjectButton(`k:${keyword}`, keyword));
		});
		lines.push(el("p", null, "Keywords (OpenAlex): ", ...names));
	}
	return el("div", { class: "entry__about" }, ...lines);
}

// Show which of the topics and keywords under the entries in `root` the sentence's subject holds.
export function showSubjects(root: ParentNode, subjects: readonly string[]) {
	for (const button of root.querySelectorAll<HTMLElement>("[data-subject]")) {
		button.setAttribute(
			"aria-pressed",
			String(subjects.includes(button.dataset.subject ?? "")),
		);
	}
}
