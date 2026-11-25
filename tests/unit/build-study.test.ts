// What scripts/deploy/build-site.ts writes for studied entries: a words file for each, a file for each character in
// use, the licence files, and the index naming them, while the month files stay as they are. The script runs on a
// copy of site/ (LIMINAL_SITE), once with a study file and once without.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { studyFiles, wordsPath } from "../../scripts/deploy/build-site.ts";
import type { CharFile, SiteIndex } from "../../shared/site-data-shape.ts";
import { charFilePath } from "../../shared/site-data-shape.ts";
import type { Study, StudyWord } from "../../shared/study-protocol.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "deploy", "build-site.ts");
const DICTIONARY = path.join(ROOT, "scripts", "lib", "hanzi", "dictionary.txt");

function word(
	text: string,
	syllables: string[],
	meaning: string,
	meaningFrom: StudyWord["meaningFrom"] = "dictionary",
): StudyWord {
	return {
		text: text,
		syllables: syllables,
		meaning: meaning,
		meaningFrom: meaningFrom,
		name: false,
		inDictionary: true,
		pinyinChecked: true,
	};
}

const PHONE: Study = {
	id: "url:https://example.com/news/1",
	title: [
		word("苹果", ["píng", "guǒ"], "apple"),
		word("发布", ["fā", "bù"], "to release"),
		word("手机", ["shǒu", "jī"], "mobile phone"),
	],
	description: [{ text: "。" }],
};
const SCHOOL: Study = {
	id: "url:https://example.com/news/2",
	title: [word("学习", ["xué", "xí"], "to study")],
	description: [word("修养", ["xiū", "yǎng"], "self-cultivation", "model")],
};
const PAPER = {
	id: "arxiv:2611.00001",
	type: "paper",
	title: "A paper",
	authors: ["A. Author"],
	published: "2026-11-01",
	source: "arXiv",
	url: "https://arxiv.org/abs/2611.00001",
	abstract: "An abstract.",
};
const NEWS = (study: Study) => ({
	id: study.id,
	type: "news",
	title: "标题",
	published: "2026-11-01",
	source: "Example",
	url: study.id.slice(4),
});
const linesOf = (studies: Study[]) =>
	studies.map((study) => `${JSON.stringify(study)}\n`).join("");

let folder: string;
let withStudy: string;
let without: string;

// Build the copy of site/ with the given study file, or none, and return the page's folder.
function buildPage(name: string, args: string[]): string {
	const dist = path.join(folder, name);
	execFileSync(
		process.execPath,
		[SCRIPT, ...args, path.join(folder, "digests.js"), dist],
		{ env: { ...process.env, LIMINAL_SITE: path.join(folder, "site") } },
	);
	return dist;
}

beforeAll(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-build-study-"));
	fs.cpSync(path.join(ROOT, "site"), path.join(folder, "site"), {
		recursive: true,
		filter: (source) => !/(digests[^/]*\.js|figures)$/.test(source),
	});
	const entries = [PAPER, NEWS(PHONE), NEWS(SCHOOL)];
	fs.writeFileSync(
		path.join(folder, "digests.js"),
		`digest(${JSON.stringify({ date: "2026-11-01", entries: entries })});\n`,
	);
	fs.writeFileSync(path.join(folder, "study.jsonl"), linesOf([PHONE, SCHOOL]));
	withStudy = buildPage("with", ["--study", path.join(folder, "study.jsonl")]);
	without = buildPage("without", []);
});

afterAll(() => {
	fs.rmSync(folder, { recursive: true, force: true });
});

const page = (dist: string, file: string) =>
	path.join(dist, "liminal-space", file);
const readPage = (dist: string, file: string) =>
	fs.readFileSync(page(dist, file), "utf8");

// The Make Me a Hanzi line for a character, read from the dictionary file itself.
function dictionaryLine(character: string): string {
	const line = fs
		.readFileSync(DICTIONARY, "utf8")
		.split("\n")
		.find((each) => each.startsWith(`{"character":"${character}"`));
	assert.ok(line, `${character} is in the dictionary`);
	return line;
}

function charFile(files: Map<string, string>, character: string): CharFile {
	const text = files.get(charFilePath(character));
	assert.ok(text, `${character} has a file`);
	return JSON.parse(text);
}

test("each studied entry gets one file of its words, and each character in use one file of its own", () => {
	for (const study of [PHONE, SCHOOL]) {
		assert.deepEqual(
			JSON.parse(readPage(withStudy, wordsPath(study.id))),
			study,
		);
	}
	const inUse = new Set(
		[PHONE, SCHOOL]
			.flatMap((study) => [...study.title, ...study.description])
			.flatMap((piece) => ("syllables" in piece ? [...piece.text] : [])),
	);
	const written = fs
		.readdirSync(page(withStudy, "study/chars"))
		.map((name) => name.replace(".json", ""))
		.sort();
	assert.deepEqual(
		written,
		[...inUse].map((c) => (c.codePointAt(0) ?? 0).toString(16)).sort(),
	);
	assert.equal(fs.readdirSync(page(withStudy, "study/words")).length, 2);
});

test("a character's file keeps its name and content across builds, so browsers keep it for a year", () => {
	const first = studyFiles(linesOf([PHONE]));
	const second = studyFiles(linesOf([SCHOOL, PHONE]));
	for (const character of "苹果发布手机") {
		const name = charFilePath(character);
		assert.equal(first.get(name), second.get(name));
		assert.ok(first.get(name));
	}
	// The headers file tells browsers to keep a character's file for a year, and a words file not at all.
	const headers = readPage(withStudy, "../_headers").split(/\n(?=\/)/);
	const rulesFor = (file: string) =>
		headers
			.filter((block) => {
				const pattern = block.split("\n")[0] ?? "";
				return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(
					`/liminal-space/${file}`,
				);
			})
			.flatMap((block) => block.split("\n").slice(1))
			.filter((line) => line.includes("Cache-Control"));
	assert.deepEqual(rulesFor(charFilePath("苹")), [
		"  Cache-Control: public, max-age=31536000, immutable",
	]);
	assert.deepEqual(rulesFor(wordsPath(PHONE.id)), [
		"  Cache-Control: no-cache",
	]);
});

test("a character's parts, definition and etymology are copied from Make Me a Hanzi as written", () => {
	const file = charFile(studyFiles(linesOf([SCHOOL])), "学");
	assert.deepEqual(file.dictionary, JSON.parse(dictionaryLine("学")));
	assert.deepEqual(
		file.parts.map((part) => part.character),
		["⺍", "冖", "子"],
	);
	const child = file.parts.find((part) => part.character === "子");
	const childRow = JSON.parse(dictionaryLine("子"));
	assert.deepEqual(child?.pinyin, childRow.pinyin);
	assert.equal(child?.definition, childRow.definition);
});

test("a character's parts carry the meaning or sound role Make Me a Hanzi gives them", () => {
	const file = charFile(studyFiles(linesOf([SCHOOL])), "修");
	const etymology = JSON.parse(dictionaryLine("修")).etymology;
	assert.equal(etymology.type, "pictophonetic");
	assert.deepEqual(
		file.parts.map((part) => [part.character, part.role]),
		[
			[etymology.phonetic, "phonetic"],
			[etymology.semantic, "semantic"],
		],
	);
	// A character that is not pictophonetic gives its parts no role.
	const ideographic = charFile(studyFiles(linesOf([SCHOOL])), "学");
	assert.ok(ideographic.parts.every((part) => part.role === undefined));
});

test("a character missing from the stroke data has no drawing, and its word keeps its pinyin and meaning", () => {
	const lucky: Study = {
		id: "url:https://example.com/news/3",
		title: [word("𠮷", ["jí"], "lucky")],
		description: [],
	};
	const files = studyFiles(linesOf([lucky]));
	const missing = charFile(files, "𠮷");
	assert.equal(missing.drawing, null);
	assert.equal(missing.dictionary, null);
	assert.deepEqual(missing.parts, []);
	const words = JSON.parse(files.get(wordsPath(lucky.id)) ?? "null");
	assert.deepEqual(words.title[0].syllables, ["jí"]);
	assert.equal(words.title[0].meaning, "lucky");
});

test("the index names each studied entry's words file, and names none for other entries", () => {
	const index: SiteIndex = JSON.parse(readPage(withStudy, "data/index.json"));
	const named = Object.fromEntries(
		index.days
			.flatMap((day) => day.entries)
			.map((entry) => [entry.id, entry.study]),
	);
	assert.deepEqual(named, {
		[PAPER.id]: undefined,
		[PHONE.id]: wordsPath(PHONE.id),
		[SCHOOL.id]: wordsPath(SCHOOL.id),
	});
	const plain: SiteIndex = JSON.parse(readPage(without, "data/index.json"));
	assert.ok(
		plain.days.flatMap((day) => day.entries).every((entry) => !entry.study),
	);
});

test("the study files ship with the Arphic, Make Me a Hanzi (with the GPL it refers to) and Hanzi Writer licence files beside them", () => {
	const licences = (name: string) =>
		readPage(withStudy, `study/licences/${name}`);
	assert.match(licences("arphic.txt"), /ARPHIC PUBLIC LICENSE/);
	assert.match(
		licences("make-me-a-hanzi.txt"),
		/GNU\s+Lesser General Public License/,
	);
	assert.match(licences("lgpl-3.0.txt"), /GNU LESSER GENERAL PUBLIC LICENSE/);
	assert.match(
		licences("gpl-3.0.txt"),
		/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/,
	);
	assert.match(licences("hanzi-writer.txt"), /The MIT License/);
});

test("the month files are the same with or without studies", () => {
	const months = (dist: string) =>
		fs
			.readdirSync(page(dist, "data/months"))
			.sort()
			.map((name) => [
				name,
				fs.readFileSync(page(dist, `data/months/${name}`), "utf8"),
			]);
	assert.deepEqual(months(withStudy), months(without));
	assert.equal(months(without).length, 1);
});

test("security: the build writes a character file only for a single Han character, so a study cannot name a path outside study/chars/", () => {
	const hostile: Study = {
		id: "url:https://example.com/news/4",
		title: [
			word("../../escape", ["x"], "a path"),
			word("苹/../果", ["píng", "guǒ"], "a path inside Han text"),
			word(".", ["x"], "a dot"),
		],
		description: [],
	};
	const files = studyFiles(linesOf([hostile]));
	const chars = [...files.keys()].filter((name) =>
		name.startsWith("study/chars/"),
	);
	assert.deepEqual(chars.sort(), ["苹", "果"].map(charFilePath).sort());
	for (const name of files.keys()) {
		assert.ok(name.startsWith("study/") && !name.includes(".."), name);
	}
});
