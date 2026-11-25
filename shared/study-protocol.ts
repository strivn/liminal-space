// An entry's Chinese study, and what sync.ts push-study sends the Worker and what it answers.
import type { JsonObject } from "./narrow.ts";

// A word to study. syllables has one toned pinyin syllable per Han character of text.
export type StudyWord = {
	text: string;
	syllables: string[];
	meaning: string;
	// Written for its sound: no character breakdown.
	name: boolean;
	inDictionary: boolean;
	pinyinChecked: boolean;
};
// Text between words: punctuation, spaces, numbers, Latin.
export type StudyGap = { text: string };
export type StudyPiece = StudyWord | StudyGap;
// title and description join back into the entry's own text, piece by piece.
export type Study = {
	id: string;
	title: StudyPiece[];
	description: StudyPiece[];
};

// The request body, JSON, at most MAX_STUDY_BYTES bytes (413 beyond):
//   {"study": {"id": "url:http://www.geekpark.net/news/374282", "title": [...], "description": [...]}}
export const MAX_STUDY_BYTES = 200_000;
// A meaning is plain text: no link, no control character.
export const MAX_MEANING_CHARS = 80;
export type StudyPush = { study: Study };

// The answer, 200, JSON:
//   stored: the study is now the entry's study, replacing any before it.
//   refused: the problems studyProblems found.
export type StudyAnswer =
	| { id: string; outcome: "stored" }
	| { id: string | null; outcome: "refused"; problems: string[] };

// What is wrong with a study of this stored entry; empty when nothing is.
export function studyProblems(_study: unknown, _entry: JsonObject): string[] {
	throw new Error("not implemented");
}
