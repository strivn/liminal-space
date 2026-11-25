// A paper's OpenAlex topics.
export type EntryOpenAlex = {
	topics: OpenAlexTopic[];
	keywords: string[];
};
export type OpenAlexTopic = { name: string; field: string; score: number };

export function openalexProblems(value: unknown): string[] {
	throw new Error(`not implemented: ${typeof value}`);
}
