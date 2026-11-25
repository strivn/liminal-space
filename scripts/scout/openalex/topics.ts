// Add OpenAlex topics to papers.
// Usage: node scripts/scout/openalex/topics.ts <digests file> [--all]
import type { EntryOpenAlex } from "../../../shared/openalex.ts";

export type OpenAlexQuestion = { id: string; title: string; doi: string };

export function topicsFromAnswer(
	questions: OpenAlexQuestion[],
	answer: unknown,
): Map<string, EntryOpenAlex> {
	throw new Error(
		`not implemented: ${questions.length} ${JSON.stringify(answer).length}`,
	);
}

if (import.meta.main) {
	throw new Error("not implemented");
}
