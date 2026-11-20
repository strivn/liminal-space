// Stemming, phrase matching and title comparison for the search plan (scripts/scout/search.ts).

// A leading label some titles carry on one site and not the other: "Position: ...", "Short Paper: ...".
const TITLE_LABEL =
	/^\s*(?:position|perspective|vision|opinion|short paper|extended abstract)\s*:\s*/i;
// How alike two titles' words must be to name the same paper (twice the shared words over both counts).
const TITLE_MATCH = 0.9;
// Words of four letters or more that say nothing about a title, left out of the looser title search.
const QUERY_STOP_WORDS = [
	"about",
	"from",
	"into",
	"over",
	"that",
	"their",
	"this",
	"what",
	"when",
	"which",
	"with",
];

// The trimmed parts of a text split at `separator`, blanks dropped. At ",": "sparse autoencoder, deception & language
// model" -> ['sparse autoencoder', 'deception & language model'], the phrases of a "Search phrases" line or a --query.
// At "&": "deception & language model" -> ['deception', 'language model'], the parts of a phrase that must all appear.
export function splitParts(text: string, separator: string): string[] {
	return text
		.split(separator)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

// A text's words, compared without case or punctuation: "Don’t Steer" -> ['don', 't', 'steer'].
// \p{L} and \p{N} are any letter and any digit in Unicode.
function words(text: string) {
	const spaced = text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	if (spaced === "") {
		return [];
	}
	return spaced.split(" ");
}

// A word's stem: the word without one common English ending and without a final "e", so "sycophancy" and
// "sycophantic" share "sycophant", "deceptive" and "deception" share "decept", "probing" and "probe" share "prob".
// The endings, longest first: ability, ities, ions, ion, ives, ive, able, ings, ing, ity, ics, ic, als, al, ies, ed, es,
// cy, ly, s. An "ncy" ending is "nt" with "cy" on it ("agency" and "agent"), so its stem keeps the "t". The "s" of a
// word ending in "ss", "us", "is" or "ias" is no ending ("class", "consensus", "analysis", "bias" aren't plurals), so
// "bias" and "biases" share "bias". A stem shorter than 3 letters is the word itself, so "age" never stands for "agent"
// while "llms" still stands for "llm".
// "policy" loses "cy" and gives "poli"; "police" has no ending and only loses its "e", giving "polic": the two
// don't share a stem.
const endings = [
	"ability",
	"ities",
	"ions",
	"ion",
	"ives",
	"ive",
	"able",
	"ings",
	"ing",
	"ity",
	"ics",
	"ic",
	"als",
	"al",
	"ies",
	"ed",
	"es",
	"cy",
	"ly",
	"s",
];
export function stemOf(word: string): string {
	let stem = word;
	// "class", "consensus", "analysis" and "bias" end in "s" without being plurals.
	const singularS =
		word.endsWith("ss") ||
		word.endsWith("us") ||
		word.endsWith("is") ||
		word.endsWith("ias");
	for (const ending of endings) {
		if (ending === "s" && singularS) {
			break;
		}
		if (word.endsWith(ending)) {
			stem = word.slice(0, -ending.length);
			break;
		}
	}
	// "sycophancy" is "sycophant" with "cy" for its "t", as "agency" is "agent".
	if (word.endsWith("ncy")) {
		stem = `${stem}t`;
	}
	if (stem.endsWith("e")) {
		stem = stem.slice(0, -1);
	}
	if (stem.length < 3) {
		return word;
	}
	return stem;
}

// A title word stands for a phrase word when the two share a stem (stemOf), which covers the plural with "s" or "es".
function sameWord(
	phraseWord: string | undefined,
	titleWord: string | undefined,
) {
	if (phraseWord === undefined || titleWord === undefined) {
		return false;
	}
	return stemOf(phraseWord) === stemOf(titleWord);
}

// True when every phrase word appears in the title, in order and next to each other.
function wordsInOrder(phraseWords: string[], titleWords: string[]) {
	for (
		let start = 0;
		start + phraseWords.length <= titleWords.length;
		start++
	) {
		let all = true;
		for (let i = 0; i < phraseWords.length; i++) {
			if (!sameWord(phraseWords[i], titleWords[start + i])) {
				all = false;
				break;
			}
		}
		if (all) {
			return true;
		}
	}
	return false;
}

// True when a list title holds a topic phrase: its words in order and next to each other, where case, punctuation and
// a plural "s" or "es" on a title word don't matter. "A & B" holds when A and B each do, anywhere in the title.
export function phraseMatches(phrase: string, title: string): boolean {
	const titleWords = words(title);
	const parts = splitParts(phrase, "&");
	if (parts.length === 0) {
		return false;
	}
	for (const part of parts) {
		const phraseWords = words(part);
		if (phraseWords.length === 0 || !wordsInOrder(phraseWords, titleWords)) {
			return false;
		}
	}
	return true;
}

// A title without one trailing parenthetical such as "(Extended Abstract)", which arXiv's title lacks.
function withoutTrailingParenthetical(title: string) {
	return title.replace(/\s*\([^()]*\)\s*$/, "");
}

// A title as compared between a list and arXiv: NFKC, one trailing parenthetical dropped, lower case, every character
// other than a letter, digit or space made a space, runs collapsed. Quotes, curly or straight, become spaces like the
// rest, so "Don’t" and "Don't" compare equal.
export function normaliseTitle(title: string): string {
	const text = withoutTrailingParenthetical(title.normalize("NFKC"));
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.replace(/ +/g, " ")
		.trim();
}

// True when two titles name the same paper though their words differ a little: a leading label such as "Position:"
// dropped, TeX marks dropped, and the two sets of words alike to at least 0.9 (twice the shared words over both
// counts).
export function titlesMatch(listed: string, other: string): boolean {
	const a = matchWords(listed);
	const b = matchWords(other);
	let shared = 0;
	for (const word of a) {
		if (b.has(word)) {
			shared += 1;
		}
	}
	return (2 * shared) / (a.size + b.size) >= TITLE_MATCH;
}

// A title's words as titlesMatch compares them: TeX marks ($, _, braces, backslashes, ^) dropped, so "$d_X$-Privacy"
// reads "dX-Privacy"; a leading label dropped; then normalised as normaliseTitle does.
function matchWords(title: string) {
	const text = title
		.normalize("NFKC")
		.replace(/[$_{}\\^]/g, "")
		.replace(TITLE_LABEL, "");
	return new Set(
		normaliseTitle(text)
			.split(" ")
			.filter((word) => word !== ""),
	);
}

// A list title as the text of arXiv's second, looser title search: its four longest words of four letters or more,
// each as ti:<word>, joined by AND; "" when it has none.
export function wordsQuery(title: string): string {
	const words = [...matchWords(title)].filter(
		(word) => /^\p{L}{4,}$/u.test(word) && !QUERY_STOP_WORDS.includes(word),
	);
	// Longest first; sort keeps title order for words of the same length.
	words.sort((a, b) => b.length - a.length);
	return words
		.slice(0, 4)
		.map((word) => `ti:${word}`)
		.join(" AND ");
}

// A list title as the text of an arXiv exact-title search, ti:"<text>": the trailing parenthetical dropped, since
// arXiv's title doesn't hold it, and every character other than a letter, digit or space made a space, since a quote
// would end the phrase and a colon would start a field. Case is kept; arXiv's search ignores it.
export function titleSearchText(title: string): string {
	const text = withoutTrailingParenthetical(title.normalize("NFKC"));
	return text
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.replace(/ +/g, " ")
		.trim();
}
