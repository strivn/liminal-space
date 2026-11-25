// An entry's Chinese study, and what sync.ts push-study sends the Worker and what it answers.
import { isJsonObject, type JsonObject } from "./narrow.ts";

// A word to study. syllables has one toned pinyin syllable per Han character of text.
export type StudyWord = {
	text: string;
	syllables: string[];
	meaning: string;
	// "model" only for a name or a term.
	meaningFrom: "dictionary" | "model";
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

const MAX_PIECES = 1000;
const ONLY_HAN = /^\p{Script=Han}+$/u;
const SYLLABLE = /^[a-züêāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]{1,7}$/;
const LINK =
	/[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:mailto|data|javascript):|\]\(|\b[a-z0-9-]+\.(?:com|net|org|io|cn|ai|dev|app|co)\b/i;
const CONTROL_OR_HIDDEN = /\p{C}/u;
const STUDY_KEYS = ["description", "id", "title"];
const WORD_KEYS = [
	"inDictionary",
	"meaning",
	"meaningFrom",
	"name",
	"pinyinChecked",
	"syllables",
	"text",
];

// True for a meaning with no link and no control character.
export function isPlainMeaning(meaning: string): boolean {
	return !LINK.test(meaning) && !CONTROL_OR_HIDDEN.test(meaning);
}

function hasKeys(value: JsonObject, keys: string[]): boolean {
	return Object.keys(value).sort().join() === keys.join();
}

function wordProblems(word: JsonObject, where: string): string[] {
	const problems: string[] = [];
	const { text, syllables, meaning } = word;
	if (!hasKeys(word, WORD_KEYS)) {
		return [`${where} is not a word: its fields are not the word's fields`];
	}
	if (typeof text !== "string" || !ONLY_HAN.test(text)) {
		return [`${where} has text that is not only Han characters`];
	}
	const characters = [...text].length;
	if (
		!Array.isArray(syllables) ||
		syllables.length !== characters ||
		!syllables.every((s) => typeof s === "string" && SYLLABLE.test(s))
	) {
		problems.push(
			`${where} does not have one pinyin syllable for each of its ${characters} characters`,
		);
	}
	const noMeaningToShow = word.meaningFrom === "dictionary";
	if (word.meaningFrom !== "dictionary" && word.meaningFrom !== "model") {
		problems.push(`${where} has a meaningFrom that is not dictionary or model`);
	}
	if (typeof meaning !== "string") {
		problems.push(`${where} has no meaning`);
	} else if (meaning.trim() === "") {
		if (!noMeaningToShow) {
			problems.push(`${where} has no meaning`);
		}
	} else if ([...meaning].length > MAX_MEANING_CHARS) {
		problems.push(
			`${where} has a meaning over ${MAX_MEANING_CHARS} characters`,
		);
	} else if (LINK.test(meaning)) {
		problems.push(`${where} has a meaning with a link`);
	} else if (CONTROL_OR_HIDDEN.test(meaning)) {
		problems.push(`${where} has a meaning with a control character`);
	}
	for (const flag of ["name", "inDictionary", "pinyinChecked"] as const) {
		if (typeof word[flag] !== "boolean") {
			problems.push(`${where} has a ${flag} that is not true or false`);
		}
	}
	return problems;
}

function piecesProblems(
	field: string,
	pieces: unknown,
	text: string,
): string[] {
	if (!Array.isArray(pieces)) {
		return [`${field} is not a list of pieces`];
	}
	if (pieces.length > MAX_PIECES) {
		return [`${field} has more than ${MAX_PIECES} pieces`];
	}
	const problems: string[] = [];
	const joined: string[] = [];
	pieces.forEach((piece: unknown, index) => {
		const where = `${field} piece ${index}`;
		if (!isJsonObject(piece)) {
			problems.push(`${where} is not an object`);
		} else if ("syllables" in piece) {
			problems.push(...wordProblems(piece, where));
		} else if (!hasKeys(piece, ["text"])) {
			problems.push(`${where} is not a gap: it has fields other than text`);
		} else if (typeof piece.text !== "string" || piece.text === "") {
			problems.push(`${where} is a gap with no text`);
		}
		if (isJsonObject(piece) && typeof piece.text === "string") {
			joined.push(piece.text);
		}
	});
	if (problems.length === 0 && joined.join("") !== text) {
		problems.push(
			`the pieces of ${field} do not join into the entry's ${field}`,
		);
	}
	return problems;
}

// What is wrong with a study of this stored entry; empty when nothing is.
export function studyProblems(study: unknown, entry: JsonObject): string[] {
	if (!isJsonObject(study) || !hasKeys(study, STUDY_KEYS)) {
		return ["the study does not have exactly an id, a title and a description"];
	}
	const problems: string[] = [];
	if (typeof entry.id !== "string" || study.id !== entry.id) {
		problems.push("the study's id is not the entry's id");
	}
	const title = typeof entry.title === "string" ? entry.title : "";
	const description =
		typeof entry.description === "string" ? entry.description : "";
	problems.push(...piecesProblems("title", study.title, title));
	problems.push(
		...piecesProblems("description", study.description, description),
	);
	return problems;
}
