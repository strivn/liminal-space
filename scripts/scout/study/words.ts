// The study word for a word the model found: its pinyin and meaning come from the dictionaries.
import type { StudyWord } from "../../../shared/study-protocol.ts";
import {
	type Dictionary,
	isCapitalised,
	meaningOf,
	splitAgain,
	toneSyllables,
	usableReadings,
} from "./cedict.ts";
import type { ModelWord } from "./cut.ts";
import { chooseReading } from "./pinyin.ts";

// The words with each plain word that CC-CEDICT does not list split into dictionary words, and how many were split.
export function splitUnlisted(
	dictionary: Dictionary,
	words: ModelWord[],
): { words: ModelWord[]; splits: number } {
	let splits = 0;
	const result = words.flatMap((word) => {
		if (
			word.kind !== "word" ||
			[...word.text].length < 2 ||
			dictionary.has(word.text)
		) {
			return [word];
		}
		splits += 1;
		return splitAgain(dictionary, word.text).map((text) => ({
			text: text,
			kind: "word" as const,
			meaning: "",
		}));
	});
	return { words: result, splits: splits };
}

// inSentence is pinyin-pro's reading of the word's characters in their sentence.
export function studyWord(
	word: ModelWord,
	inSentence: string[],
	dictionary: Dictionary,
): StudyWord {
	const readings = usableReadings(dictionary, word.text);
	const chosen = chooseReading(readings, inSentence, word.kind === "name");
	const listed = dictionary.get(word.text);
	const meaningReading = chosen ?? listed?.[0];
	const fromModel =
		word.meaning.trim() !== "" &&
		(word.kind === "term" || word.kind === "name") &&
		(listed === undefined ||
			(word.kind === "term" && !listed.some(isCapitalised)));
	let meaning = "";
	if (fromModel) {
		meaning = word.meaning;
	} else if (meaningReading !== undefined) {
		meaning = meaningOf(meaningReading);
	}
	return {
		text: word.text,
		syllables: chosen === null ? inSentence : toneSyllables(chosen.pinyin),
		meaning: meaning,
		meaningFrom: fromModel ? "model" : "dictionary",
		name: word.kind === "name",
		inDictionary: dictionary.has(word.text),
		pinyinChecked: readings.length === 1,
	};
}
