// Prepare the words of Chinese entries for study.
// Usage: node scripts/scout/study/study.ts <digests file> <study file>                  today's Chinese entries
//        node scripts/scout/study/study.ts <digests file> <study file> --since <date>   every Chinese entry from <date>
// The study file holds one Study per line (shared/study-protocol.ts); entries already in it are skipped.
// Tests set STUDY_SDK (the model's stand-in) and CEDICT_URL (the dictionary's address).
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../../shared/narrow.ts";
import {
	MAX_STUDY_BYTES,
	type Study,
	type StudyPiece,
	studyProblems,
} from "../../../shared/study-protocol.ts";
import { readDigests } from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import { jakartaToday } from "../../lib/run-date.ts";
import { type Dictionary, loadDictionary } from "./cedict.ts";
import {
	cutField,
	type ModelWord,
	splitSentences,
	withOmitted,
} from "./cut.ts";
import { askModel } from "./model.ts";
import { sentenceReading } from "./pinyin.ts";
import {
	parseStudyAnswer,
	type SentenceRef,
	STUDY_SCHEMA,
	studyPrompt,
} from "./prompt.ts";
import { splitUnlisted, studyWord } from "./words.ts";

const USAGE =
	"usage: node scripts/scout/study/study.ts <digests file> <study file> [--since <date>]";
const HAN = /\p{Script=Han}/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ["title", "description"] as const;

// At most this many entries go to the model in one run.
export const MAX_ENTRIES_PER_RUN = 10;

export type StudyRunReport = {
	studied: string[];
	refused: { id: string; problems: string[] }[];
	skipped: string[];
};

// The run's dictionary could not be loaded, so nothing was studied.
export class DictionaryUnavailable extends Error {}

// An entry is Chinese when its title has a Han character.
export function isChinese(entry: JsonObject): boolean {
	return typeof entry.title === "string" && HAN.test(entry.title);
}

// The ids in a study file; a missing file holds none.
function studiedIds(studyFile: string): Set<string> {
	let text = "";
	try {
		text = readFileSync(studyFile, "utf8");
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			throw error;
		}
	}
	const ids = new Set<string>();
	for (const line of text.split("\n")) {
		if (line === "") {
			continue;
		}
		const study: unknown = JSON.parse(line);
		if (!isJsonObject(study) || typeof study.id !== "string") {
			throw new Error("the study file has a line that is not a study");
		}
		ids.add(study.id);
	}
	return ids;
}

// The Chinese entries of the digest lines dated since or later, newest line first.
function chineseEntries(digestsFile: string, since: string): JsonObject[] {
	const stop = (line: number, problem: string): never => {
		throw new Error(`${digestsFile} line ${line} ${problem}`);
	};
	const found: JsonObject[] = [];
	for (const { digest } of readDigests(digestsFile, stop).digests.reverse()) {
		if (
			!isJsonObject(digest) ||
			typeof digest.date !== "string" ||
			digest.date < since
		) {
			continue;
		}
		const entries = Array.isArray(digest.entries) ? digest.entries : [];
		found.push(...entries.filter(isJsonObject).filter(isChinese));
	}
	return found;
}

type Studied =
	| {
			study: Study;
			splits: number;
			added: number;
			ms: number;
			inputTokens: number;
			outputTokens: number;
	  }
	| { problems: string[] };

// Study one entry: ask the model for the words, cut them from the stored text, take pinyin and meanings from the dictionaries.
async function studyOne(
	entry: JsonObject,
	dictionary: Dictionary,
	scratch: string,
): Promise<Studied> {
	const texts = {
		title: typeof entry.title === "string" ? entry.title : "",
		description: typeof entry.description === "string" ? entry.description : "",
	};
	const sentences = FIELDS.map((field) => splitSentences(texts[field]));
	const asked: SentenceRef[] = [];
	for (const [fieldIndex, field] of FIELDS.entries()) {
		for (const text of sentences[fieldIndex] ?? []) {
			if (HAN.test(text)) {
				asked.push({ index: asked.length, field: field, text: text });
			}
		}
	}
	const answer = await askModel(studyPrompt(asked), STUDY_SCHEMA, scratch);
	if (typeof answer === "string") {
		return { problems: [answer] };
	}
	const modelWords = parseStudyAnswer(
		answer.output,
		asked.map((s) => s.index),
	);
	if (typeof modelWords === "string") {
		return { problems: [modelWords] };
	}
	let splits = 0;
	let added = 0;
	let next = 0;
	const pieces: Record<(typeof FIELDS)[number], StudyPiece[]> = {
		title: [],
		description: [],
	};
	for (const [fieldIndex, field] of FIELDS.entries()) {
		const fieldSentences = sentences[fieldIndex] ?? [];
		const wordsOfSentence: ModelWord[][] = fieldSentences.map((text) => {
			if (!HAN.test(text)) {
				return [];
			}
			const filled = withOmitted(text, modelWords.get(next++) ?? []);
			const split = splitUnlisted(dictionary, filled.words);
			added += filled.added;
			splits += split.splits;
			return split.words;
		});
		const cuts = cutField(fieldSentences, wordsOfSentence);
		if (typeof cuts === "string") {
			return { problems: [cuts] };
		}
		const reading = fieldSentences.flatMap(sentenceReading);
		let offset = 0;
		pieces[field] = cuts.map((cut) => {
			const length = [...cut.text].length;
			const inSentence = reading.slice(offset, offset + length);
			offset += length;
			if (cut.word === null) {
				return { text: cut.text };
			}
			return studyWord(cut.word, inSentence, dictionary);
		});
	}
	const study: Study = {
		id: String(entry.id),
		title: pieces.title,
		description: pieces.description,
	};
	const problems = studyProblems(study, entry);
	if (Buffer.byteLength(JSON.stringify({ study: study })) > MAX_STUDY_BYTES) {
		problems.push(`the study is over ${MAX_STUDY_BYTES} bytes`);
	}
	if (problems.length > 0) {
		return { problems: problems };
	}
	return {
		study: study,
		splits: splits,
		added: added,
		ms: answer.ms,
		inputTokens: answer.inputTokens,
		outputTokens: answer.outputTokens,
	};
}

// Study the Chinese entries dated from since that the study file lacks, and append them to it.
export async function studyEntries(
	digestsFile: string,
	studyFile: string,
	since: string,
): Promise<StudyRunReport> {
	const done = studiedIds(studyFile);
	const wanted = chineseEntries(digestsFile, since).filter(
		(entry) => !done.has(String(entry.id)),
	);
	const report: StudyRunReport = { studied: [], refused: [], skipped: [] };
	report.skipped = wanted
		.slice(MAX_ENTRIES_PER_RUN)
		.map((entry) => String(entry.id));
	const entries = wanted.slice(0, MAX_ENTRIES_PER_RUN);
	if (entries.length === 0) {
		return report;
	}
	const dictionary = await loadDictionary();
	if (typeof dictionary === "string") {
		throw new DictionaryUnavailable(dictionary);
	}
	const scratch = mkdtempSync(join(tmpdir(), "study-"));
	try {
		await Promise.all(
			entries.map(async (entry) => {
				const id = String(entry.id);
				const result = await studyOne(entry, dictionary, scratch);
				if ("problems" in result) {
					report.refused.push({ id: id, problems: result.problems });
					console.error(`refused ${id}: ${result.problems.join("; ")}`);
					return;
				}
				appendFileSync(studyFile, `${JSON.stringify(result.study)}\n`);
				report.studied.push(id);
				const all = [...result.study.title, ...result.study.description].filter(
					(piece) => "syllables" in piece,
				);
				const fromModel = all.filter((w) => w.meaningFrom === "model");
				console.log(
					`studied ${id}: ${all.length} words, ${result.splits} split again, ${result.added} left out by the model and added, ${fromModel.length} meanings from the model (${fromModel.map((w) => w.text).join(" ")}), ${all.filter((w) => !w.pinyinChecked).length} not confirmed, ${all.filter((w) => !w.inDictionary).length} not in CC-CEDICT, ${result.ms} ms, ${result.inputTokens} tokens in, ${result.outputTokens} out`,
				);
			}),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return report;
}

async function main(args: string[]): Promise<void> {
	const fail: Fail = failer("study.ts");
	const [digestsFile, studyFile, option, date, ...extra] = args;
	if (
		digestsFile === undefined ||
		studyFile === undefined ||
		extra.length > 0
	) {
		fail(USAGE);
	}
	let since = jakartaToday();
	if (option !== undefined) {
		if (
			option !== "--since" ||
			date === undefined ||
			!DATE.test(date) ||
			Number.isNaN(Date.parse(date))
		) {
			fail(USAGE);
		}
		since = date;
	}
	try {
		const report = await studyEntries(digestsFile, studyFile, since);
		console.log(
			`study.ts: ${report.studied.length} studied, ${report.refused.length} refused, ${report.skipped.length} left for the next run`,
		);
		if (report.refused.length > 0) {
			process.exitCode = 1;
		}
	} catch (error) {
		if (error instanceof DictionaryUnavailable) {
			fail(`${error.message}; nothing was studied`);
		}
		throw error;
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
