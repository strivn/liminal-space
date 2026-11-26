// Cut an entry's text into sentences, and into pieces at the model's word boundaries.

// What the model says about one word: a name, a term (its meaning is not in a general dictionary) or neither.
// Only a name or a term comes with a meaning.
export type ModelWord = {
	text: string;
	kind: "name" | "term" | "word";
	meaning: string;
};

// A piece of a field's text: a word, or a gap (no word) between words.
export type Cut = { text: string; word: ModelWord | null };

// The cut-off word of a description that ends in "…" is at most this many characters.
const MAX_CUT_CHARACTERS = 6;
const HAN = /\p{Script=Han}/u;
const ONLY_HAN = /^\p{Script=Han}+$/u;
// The Han characters just before a closing …, with the … itself.
const CUT_WORD = /\p{Script=Han}+…$/u;

// The text in sentences, split after 。！？； and the closing quotes that follow them.
export function splitSentences(text: string): string[] {
	return text.split(/(?<=[。！？；][」』”’）)]*)/u).filter((s) => s !== "");
}

// The words with every run of Han characters the model left out, or put in a word with other text, added as a plain
// word, in its place, and how many were added. The cut-off word before a closing … stays out. Words that are not in the
// sentence are left for cutField to refuse.
export function withOmitted(
	sentence: string,
	modelWords: ModelWord[],
): { words: ModelWord[]; added: number } {
	// Non-Han words become text.
	const words = modelWords.filter((word) => ONLY_HAN.test(word.text));
	const plain = (text: string): ModelWord[] =>
		(text.match(/\p{Script=Han}+/gu) ?? []).map((run) => ({
			text: run,
			kind: "word",
			meaning: "",
		}));
	const result: ModelWord[] = [];
	let added = 0;
	let cursor = 0;
	for (const word of words) {
		const at = sentence.indexOf(word.text, cursor);
		if (word.text === "" || at < 0) {
			return { words: words, added: 0 };
		}
		const omitted = plain(sentence.slice(cursor, at));
		added += omitted.length;
		result.push(...omitted, word);
		cursor = at + word.text.length;
	}
	const rest = sentence.slice(cursor);
	// A last word right before the closing … is a cut-off word, whatever the model made of it.
	if (rest === "…") {
		result.pop();
		return { words: result, added: added };
	}
	const cutWord = rest.match(CUT_WORD)?.[0] ?? "";
	const omitted = plain(rest.slice(0, rest.length - cutWord.length));
	return { words: [...result, ...omitted], added: added + omitted.length };
}

// One sentence's pieces: each word where the sentence has it, and the text between words as gaps.
function cutSentence(sentence: string, words: ModelWord[]): Cut[] | string {
	const cuts: Cut[] = [];
	let cursor = 0;
	for (const word of words) {
		const at = sentence.indexOf(word.text, cursor);
		if (word.text === "" || at < 0) {
			return `the word "${word.text}" is not in the sentence after the words before it`;
		}
		if (at > cursor) {
			cuts.push({ text: sentence.slice(cursor, at), word: null });
		}
		cuts.push({ text: word.text, word: word });
		cursor = at + word.text.length;
	}
	if (cursor < sentence.length) {
		cuts.push({ text: sentence.slice(cursor), word: null });
	}
	return cuts;
}

// Join neighbouring gaps into one.
function mergeGaps(cuts: Cut[]): Cut[] {
	const merged: Cut[] = [];
	for (const cut of cuts) {
		const last = merged.at(-1);
		if (last !== undefined && last.word === null && cut.word === null) {
			merged[merged.length - 1] = { text: last.text + cut.text, word: null };
		} else {
			merged.push(cut);
		}
	}
	return merged;
}

// A field's pieces from its sentences and the words the model found in each; a string says what is wrong.
// A trailing "…" and the word it cuts become a gap, and no other Han text may be left outside a word.
export function cutField(
	sentences: string[],
	wordsOfSentence: ModelWord[][],
): Cut[] | string {
	const all: Cut[] = [];
	for (const [index, sentence] of sentences.entries()) {
		const cuts = cutSentence(sentence, wordsOfSentence[index] ?? []);
		if (typeof cuts === "string") {
			return cuts;
		}
		all.push(...cuts);
	}
	const last = all.at(-2);
	if (
		sentences.join("").endsWith("…") &&
		all.at(-1)?.text === "…" &&
		last?.word
	) {
		all.splice(-2, 1, { text: last.text, word: null });
	}
	const cuts = mergeGaps(all);
	for (const [index, cut] of cuts.entries()) {
		if (cut.word !== null || !HAN.test(cut.text)) {
			continue;
		}
		const cutWord = cut.text.match(CUT_WORD)?.[0] ?? "";
		const isCutWord =
			index === cuts.length - 1 &&
			cutWord !== "" &&
			[...cutWord].length <= MAX_CUT_CHARACTERS + 1 &&
			!HAN.test(cut.text.slice(0, cut.text.length - cutWord.length));
		if (!isCutWord) {
			return `the model left Han text "${cut.text.slice(0, 20)}" outside its words`;
		}
	}
	return cuts;
}
