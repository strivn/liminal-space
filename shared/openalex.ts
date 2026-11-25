// A paper's OpenAlex topics.
import { isJsonObject } from "./narrow.ts";

export type EntryOpenAlex = {
	topics: OpenAlexTopic[];
	keywords: string[];
};
export type OpenAlexTopic = { name: string; field: string; score: number };

export const OPENALEX_CAPS = { topics: 10, keywords: 20, text: 200 };

function isText(value: unknown) {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value.length <= OPENALEX_CAPS.text
	);
}

function topicProblems(topic: unknown) {
	if (!isJsonObject(topic)) {
		return ["openalex.topics must hold a name, a field and a score"];
	}
	const problems = [];
	for (const key of ["name", "field"]) {
		if (!isText(topic[key])) {
			problems.push(
				`openalex.topics ${key} must be text of up to ${OPENALEX_CAPS.text} characters`,
			);
		}
	}
	if (
		typeof topic.score !== "number" ||
		!(topic.score >= 0 && topic.score <= 1)
	) {
		problems.push("openalex.topics score must be a number from 0 to 1");
	}
	return problems;
}

// What an openalex field breaks.
export function openalexProblems(value: unknown): string[] {
	if (!isJsonObject(value)) {
		return ["openalex must hold topics and keywords"];
	}
	const problems = [];
	if (
		!Array.isArray(value.topics) ||
		value.topics.length === 0 ||
		value.topics.length > OPENALEX_CAPS.topics
	) {
		problems.push(
			`openalex.topics must hold 1 to ${OPENALEX_CAPS.topics} topics`,
		);
	} else {
		for (const topic of value.topics) {
			for (const problem of topicProblems(topic)) {
				problems.push(problem);
			}
		}
	}
	if (
		!Array.isArray(value.keywords) ||
		value.keywords.length > OPENALEX_CAPS.keywords
	) {
		problems.push(
			`openalex.keywords must be a list of up to ${OPENALEX_CAPS.keywords} keywords`,
		);
	} else if (!value.keywords.every(isText)) {
		problems.push(
			`openalex.keywords must be text of up to ${OPENALEX_CAPS.text} characters`,
		);
	}
	return [...new Set(problems)];
}
