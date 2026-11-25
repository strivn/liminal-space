// pinyin-pro's reading of a sentence in context, and the dictionary reading that agrees with it.
import { pinyin } from "pinyin-pro";
import type { Reading } from "./cedict.ts";
import { isCapitalised, toneSyllables } from "./cedict.ts";

// One reading for each character of a sentence, in dictionary tones: no change of tone for 一 and 不.
export function sentenceReading(sentence: string): string[] {
	return pinyin(sentence, {
		type: "array",
		toneType: "symbol",
		toneSandhi: false,
	});
}

function same(a: string[], b: string[]): boolean {
	return (
		a.length === b.length &&
		a.every((s, i) => s.normalize("NFC") === b[i]?.normalize("NFC"))
	);
}

// The reading pinyin-pro chose for a word among the dictionary's: the only one, or the one it reads in the sentence
// (the first listed when it reads none of them). Of readings that differ only in a capital letter (元 Yuan2, yuan2),
// the one that fits the word: capitalised for a name, else not. null when the dictionary lists none.
export function chooseReading(
	readings: Reading[],
	inSentence: string[],
	isName: boolean,
): Reading | null {
	const [first] = readings;
	if (first === undefined || readings.length === 1) {
		return first ?? null;
	}
	const read = inSentence.map((s) => s.toLowerCase());
	const matches = readings.filter((reading) =>
		same(toneSyllables(reading.pinyin), read),
	);
	return (
		matches.find((reading) => isCapitalised(reading) === isName) ??
		matches[0] ??
		first
	);
}
