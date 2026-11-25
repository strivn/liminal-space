// CC-CEDICT, the open Chinese-English dictionary (CC BY-SA 4.0): downloaded into the cache, read from it for a week.
import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { convert } from "pinyin-pro";
import { errorCode } from "../../../shared/narrow.ts";
import {
	isPlainMeaning,
	MAX_MEANING_CHARS,
} from "../../../shared/study-protocol.ts";
import { cacheFolder } from "../../lib/cli.ts";
import { request } from "../../lib/http.ts";

const DEFAULT_URL =
	"https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// The file is about 4 MB compressed and 10 MB as text.
const MAX_DOWNLOAD_BYTES = 30_000_000;
const MAX_TEXT_BYTES = 80_000_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.+)\/$/u;
const GZIP_MAGIC = [0x1f, 0x8b];

// One reading of a word: its numbered pinyin as CC-CEDICT writes it, and its senses.
export type Reading = { pinyin: string; senses: string[] };
// Simplified word to its readings.
export type Dictionary = Map<string, Reading[]>;

// The dictionary a text holds, or what is wrong with it. Every line is a comment or an entry.
export function parseDictionary(text: string): Dictionary | string {
	const dictionary: Dictionary = new Map();
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const match = LINE.exec(line);
		if (match === null) {
			return `line ${index + 1} is not a CC-CEDICT entry`;
		}
		const [, , simplified = "", pinyin = "", glosses = ""] = match;
		const readings = dictionary.get(simplified) ?? [];
		const senses = glosses.split("/");
		const same = readings.find((reading) => reading.pinyin === pinyin);
		if (same === undefined) {
			readings.push({ pinyin: pinyin, senses: senses });
		} else {
			same.senses.push(...senses);
		}
		dictionary.set(simplified, readings);
	}
	if (dictionary.size === 0) {
		return "it has no entries";
	}
	return dictionary;
}

function decode(bytes: Buffer): string {
	const text = GZIP_MAGIC.every((byte, i) => bytes[i] === byte)
		? gunzipSync(bytes, { maxOutputLength: MAX_TEXT_BYTES })
		: bytes;
	return new TextDecoder("utf-8", { fatal: true }).decode(text);
}

// The cache's age in milliseconds, or null when there is no cache.
function cacheAge(file: string): number | null {
	try {
		return Date.now() - statSync(file).mtimeMs;
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return null;
		}
		throw error;
	}
}

// Download, check and cache the dictionary; a string says why that failed.
async function download(file: string): Promise<string | null> {
	const url = process.env.CEDICT_URL || DEFAULT_URL;
	const answer = await request(url, {
		maxBytes: MAX_DOWNLOAD_BYTES,
		timeoutMs: DOWNLOAD_TIMEOUT_MS,
	});
	if ("problem" in answer) {
		return `the download ${answer.problem}`;
	}
	if (!answer.ok) {
		return `the download answered HTTP ${answer.status}`;
	}
	let text: string;
	try {
		text = decode(answer.bytes);
	} catch {
		return "the download is not a gzip or UTF-8 text file";
	}
	const checked = parseDictionary(text);
	if (typeof checked === "string") {
		return `the download is not CC-CEDICT: ${checked}`;
	}
	mkdirSync(cacheFolder(), { recursive: true });
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
	return null;
}

// The dictionary from the cache, downloaded again when it is over a week old; a string says why it can't be loaded.
// A stale cache stands in when the download fails.
export async function loadDictionary(): Promise<Dictionary | string> {
	const file = join(cacheFolder(), "cedict.txt");
	const age = cacheAge(file);
	let problem: string | null = null;
	if (age === null || age > MAX_AGE_MS) {
		problem = await download(file);
		if (problem !== null && age === null) {
			return `CC-CEDICT could not be loaded: ${problem}`;
		}
	}
	const dictionary = parseDictionary(readFileSync(file, "utf8"));
	if (typeof dictionary === "string") {
		return `CC-CEDICT could not be loaded: the cached file is wrong: ${dictionary}`;
	}
	return dictionary;
}

// CC-CEDICT's numbered pinyin ("yin2 hang2", "nu:3", "r5") as toned syllables.
export function toneSyllables(pinyin: string): string[] {
	return pinyin.split(" ").map((syllable) =>
		convert(syllable.replace("u:", "ü").replace(/5$/, ""), {
			format: "numToSymbol",
		}).toLowerCase(),
	);
}

// A reading as the dictionary writes it with a capital letter: a name.
export function isCapitalised(reading: Reading): boolean {
	return /^\p{Lu}/u.test(reading.pinyin);
}

// The readings of a word that have one syllable for each of its characters.
export function usableReadings(
	dictionary: Dictionary,
	word: string,
): Reading[] {
	const characters = [...word].length;
	return (dictionary.get(word) ?? []).filter(
		(reading) => reading.pinyin.split(" ").length === characters,
	);
}

// As many whole senses as fit in MAX_MEANING_CHARS characters; a first sense that is longer is cut.
// A sense with a link or a control character is left out.
export function meaningOf(reading: Reading): string {
	let meaning = "";
	const senses = reading.senses.filter(isPlainMeaning);
	for (const sense of senses) {
		const next = meaning === "" ? sense : `${meaning}; ${sense}`;
		if ([...next].length > MAX_MEANING_CHARS) {
			break;
		}
		meaning = next;
	}
	const [first] = senses;
	if (meaning === "" && first !== undefined) {
		meaning = `${[...first].slice(0, MAX_MEANING_CHARS - 1).join("")}…`;
	}
	return meaning;
}

// A word as the longest dictionary words from its start, or from its end, whichever has fewer; the start wins a tie.
export function splitAgain(dictionary: Dictionary, word: string): string[] {
	const characters = [...word];
	const longestFrom = (rest: string[], atEnd: boolean): number => {
		for (let length = rest.length; length > 1; length--) {
			const part = atEnd ? rest.slice(-length) : rest.slice(0, length);
			if (dictionary.has(part.join(""))) {
				return length;
			}
		}
		return 1;
	};
	const split = (atEnd: boolean): string[] => {
		const parts: string[] = [];
		let rest = characters;
		while (rest.length > 0) {
			const length = longestFrom(rest, atEnd);
			parts.push(
				(atEnd ? rest.slice(-length) : rest.slice(0, length)).join(""),
			);
			rest = atEnd ? rest.slice(0, -length) : rest.slice(length);
		}
		return atEnd ? parts.reverse() : parts;
	};
	const forward = split(false);
	const backward = split(true);
	return backward.length < forward.length ? backward : forward;
}
