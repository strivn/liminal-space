// A paper's OpenAlex lines under its abstract.
import { isJsonObject } from "../../shared/narrow.ts";
import { OPENALEX_CAPS } from "../../shared/openalex.ts";
import { isCapped } from "./data.ts";
import { el } from "./dom.ts";
import type { Entry } from "./types.ts";

const KEYWORDS_SHOWN = 5;

const isText = (value: unknown): value is string =>
	isCapped(value, OPENALEX_CAPS.text);

// The main topic (null when none yet) and the keywords.
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

// A button; `subject` is "t:<topic>" or "k:<keyword>".
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

// Topic and keyword lines; null for non-papers.
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

// Press the buttons the subject holds.
export function showSubjects(root: ParentNode, subjects: readonly string[]) {
	for (const button of root.querySelectorAll<HTMLElement>("[data-subject]")) {
		button.setAttribute(
			"aria-pressed",
			String(subjects.includes(button.dataset.subject ?? "")),
		);
	}
}
