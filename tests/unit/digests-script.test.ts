// Unit tests for the program scripts/digests/digests.ts (status, add, check), run as the scout runs it, on files in a folder of
// the test's own. The checks each command makes are tested through their exports in digests.test.ts; these tests run
// the program itself: what it writes, prints and leaves alone, and its exit code. One add call carries many entries that
// each go their own way; the commands that write nothing run side by side.
import { execFile } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

const SCRIPT = new URL("../../scripts/digests/digests.ts", import.meta.url);
const run = promisify(execFile);
const TODAY = "2026-10-20";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-digests-script-"));
let folder = "";
let counter = 0;

beforeEach(() => {
	counter += 1;
	folder = join(WORK, `run-${counter}`);
	mkdirSync(folder);
});
afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

type Result = { code: number; stdout: string; stderr: string };

// digests.ts with the given arguments, in the run's folder, with today set.
async function digests(
	args: string[],
	script: string = SCRIPT.pathname,
): Promise<Result> {
	try {
		const done = await run(process.execPath, [script, ...args], {
			cwd: folder,
			env: { ...process.env, LIMINAL_TODAY: TODAY },
			timeout: 60_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

// A news entry as an items file holds it; n picks its address.
function news(n: number | string, extra: Record<string, unknown> = {}) {
	return {
		type: "news",
		title: `Fixture news story ${n}`,
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "Fixture Times",
		url: `https://example.com/news/${n}`,
		...extra,
	};
}

// A news entry as the digests file holds it.
function storedNews(n: number | string, extra: Record<string, unknown> = {}) {
	return { id: `url:https://example.com/news/${n}`, ...news(n, extra) };
}

// A paper as the digests file holds it.
function paper(n: number) {
	const id = `2601.${String(n).padStart(5, "0")}`;
	return {
		id: `arxiv:${id}`,
		type: "paper",
		title: `Fixture paper ${n}`,
		authors: ["Ada Example"],
		published: "2026-01-02",
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${id}`,
		links: [{ label: "PDF", url: `https://arxiv.org/pdf/${id}` }],
		abstract: "Researchers report measurements.",
	};
}

// One digest line as the scripts write it, ending in a line break.
function line(date: string, entries: unknown[]) {
	return `digest(${JSON.stringify({ date: date, entries: entries })});\n`;
}

const OLD_LINE = line("2026-10-01", [paper(1)]);

// A file in the run's folder holding `content`; its path.
function fileWith(name: string, content: string | object) {
	const file = join(folder, name);
	if (typeof content === "string") {
		writeFileSync(file, content);
	} else {
		writeFileSync(file, JSON.stringify(content));
	}
	return file;
}

// The entries of every line a digests file holds after its first, each line with its date.
function addedLines(file: string) {
	return readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((each) => JSON.parse(each.slice("digest(".length, -");".length)));
}

describe("add", () => {
	test("one add call appends the good entries as one line under the --date day, marked ad hoc, and names each refused or skipped entry and why", async () => {
		const stored = line("2026-10-02", [
			storedNews(42, {
				url: "https://www.example.com/story/42?utm_source=rss",
				id: "url:https://www.example.com/story/42?utm_source=rss",
			}),
			storedNews("item", { url: "https://example.com/item?id=1" }),
		]);
		const file = fileWith("digests.js", OLD_LINE + stored);
		const items = fileWith("items.json", [
			news(1),
			news(2, { type: "article" }),
			news(3, { type: "report" }),
			news(4, { published: "2026-10-03T19:27:17Z" }),
			news(5, { abstract: "x" }),
			news(6, { url: "ftp://example.com/news/6" }),
			news(7, { url: undefined }),
			news(8, { id: "url:https://example.com/news/9" }),
			news(9, { url: "http://www.example.com/story/42#comments" }),
			news(10, { type: "article", url: "https://arxiv.org/abs/2601.00001" }),
			news(1),
			news(12, { url: "https://example.com/item?id=2" }),
		]);
		const result = await digests([
			"add",
			"--date",
			"2026-10-17",
			file,
			items,
			"--ad-hoc",
		]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe(
			"added url:https://example.com/news/1 Fixture news story 1\n" +
				"added url:https://example.com/news/2 Fixture news story 2\n" +
				"added url:https://example.com/news/3 Fixture news story 3\n" +
				"added url:https://example.com/item?id=2 Fixture news story 12\n",
		);
		for (const said of [
			"refused https://example.com/news/4: published must be YYYY-MM-DD",
			'refused https://example.com/news/5: "abstract" is not in the schema',
			'refused "Fixture news story 6": url must be http or https',
			'refused "Fixture news story 7": url is missing',
			"refused https://example.com/news/8:",
			`already in ${file}, skipped: http://www.example.com/story/42#comments`,
			`already in ${file}, skipped: https://arxiv.org/abs/2601.00001`,
			"already added in this call, skipped: https://example.com/news/1",
		]) {
			expect(result.stderr).toContain(said);
		}
		expect(result.stderr).toMatch(
			/refused https:\/\/example.com\/news\/8: .*id/,
		);
		const text = readFileSync(file, "utf8");
		expect(text.startsWith(OLD_LINE + stored)).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
		const lines = addedLines(file);
		expect(lines).toHaveLength(2);
		const added = lines[1];
		expect(added.date).toBe("2026-10-17");
		expect(added.entries.map((entry: { url: string }) => entry.url)).toEqual([
			"https://example.com/news/1",
			"https://example.com/news/2",
			"https://example.com/news/3",
			"https://example.com/item?id=2",
		]);
		expect(added.entries[0]).toEqual({
			id: "url:https://example.com/news/1",
			...news(1),
			ad_hoc: true,
		});
		expect(Object.keys(added.entries[0]).at(-1)).toBe("ad_hoc");
		expect(added.entries.map((entry: { type: string }) => entry.type)).toEqual([
			"news",
			"article",
			"report",
			"news",
		]);
	});

	test("add skips and names entries already in the file, adds the rest under today's date, and exits 0", async () => {
		const file = fileWith(
			"digests.js",
			OLD_LINE + line("2026-10-02", [storedNews(1)]),
		);
		const items = fileWith("items.json", [news(1), news(2)]);
		const result = await digests(["add", file, items]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(
			`already in ${file}, skipped: https://example.com/news/1`,
		);
		const added = addedLines(file).at(-1);
		expect(added.date).toBe(TODAY);
		expect(added.entries.map((entry: { id: string }) => entry.id)).toEqual([
			"url:https://example.com/news/2",
		]);
	});

	test("an items file holding one object adds one entry, and a last line with no line break gets one before the new line", async () => {
		const last = OLD_LINE.trimEnd().slice(0, -1);
		const file = fileWith("digests.js", last);
		const items = fileWith("items.json", news(1));
		const result = await digests(["add", file, items]);
		expect(result.code).toBe(0);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(last);
		expect(addedLines(file)[0].entries).toHaveLength(1);
	});

	test("a digests file reached through a symbolic link stays a link, and the file it points to gains the line", async () => {
		const elsewhere = join(folder, "elsewhere");
		mkdirSync(elsewhere);
		const target = join(elsewhere, "digests.js");
		writeFileSync(target, OLD_LINE);
		const link = join(folder, "digests.js");
		symlinkSync(target, link);
		const result = await digests([
			"add",
			link,
			fileWith("items.json", [news(1)]),
		]);
		expect(result.code).toBe(0);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(target);
		expect(readFileSync(target, "utf8").trimEnd().split("\n")).toHaveLength(2);
	});
});

// A command that writes nothing: its arguments (FILE and ITEMS stand for the files it is given), what the files hold,
// the exit code and what it prints. `unchanged` names the file that must stay as it was.
type Row = {
	name: string;
	args: string[];
	digests?: string | null; // the digests file's content; null for none
	items?: string | object;
	code: number;
	stdout?: string[];
	stderr?: string[];
	never?: string[]; // text that must appear in neither stream
};

const SECRET_LINE = `${OLD_LINE}SECRET-7f3a(not a digest)\n`;
const ITEMS_OK = [news(1)];

const ROWS: Row[] = [
	// a --date that can't be filled in is refused before the file is read (a file that doesn't load would be named first)
	{
		name: "add --date after today",
		args: ["add", "--date", "2026-10-21", "FILE", "ITEMS"],
		digests: SECRET_LINE,
		items: ITEMS_OK,
		code: 1,
		stderr: ["--date is after today"],
		never: ["doesn't load"],
	},
	{
		name: "status --date after today",
		args: ["status", "--date", "2026-10-21", "FILE"],
		digests: SECRET_LINE,
		code: 1,
		stderr: ["--date is after today"],
		never: ["doesn't load"],
	},
	{
		name: "add --date 8 days back",
		args: ["add", "--date", "2026-10-12", "FILE", "ITEMS"],
		digests: SECRET_LINE,
		items: ITEMS_OK,
		code: 1,
		stderr: ["--date is more than 7 days before today"],
	},
	{
		name: "add --date not a date",
		args: ["add", "--date", "2026-10-1", "FILE", "ITEMS"],
		digests: SECRET_LINE,
		items: ITEMS_OK,
		code: 1,
		stderr: ["--date must be YYYY-MM-DD"],
	},
	// a line that doesn't load is named by its number and never quoted
	{
		name: "add on a line that doesn't load",
		args: ["add", "FILE", "ITEMS"],
		digests: SECRET_LINE,
		items: ITEMS_OK,
		code: 1,
		stderr: ["line 2 of"],
		never: ["SECRET-7f3a"],
	},
	{
		name: "status on a line that doesn't load",
		args: ["status", "FILE"],
		digests: SECRET_LINE,
		code: 1,
		stderr: ["line 2"],
		never: ["SECRET-7f3a"],
	},
	{
		name: "check on a line that doesn't load",
		args: ["check", "FILE"],
		digests: SECRET_LINE,
		code: 1,
		stderr: ["line 2"],
		never: ["SECRET-7f3a"],
	},
	// an items file that can't be used
	{
		name: "an items file that is not JSON",
		args: ["add", "FILE", "ITEMS"],
		items: "SECRET-7f3a not json",
		code: 1,
		stderr: ["is not JSON"],
		never: ["SECRET-7f3a"],
	},
	{
		name: "an items file holding an empty list",
		args: ["add", "FILE", "ITEMS"],
		items: "[]",
		code: 1,
		stderr: ["holds no entries"],
	},
	{
		name: "no items file",
		args: ["add", "FILE", "missing-items.json"],
		code: 1,
		stderr: ["doesn't exist"],
	},
	// check names every line it can't accept
	{
		name: "check on two bad lines",
		args: ["check", "FILE"],
		digests: `${OLD_LINE}digest({"date":"2026-10-02","entries":[{"id":"x",}]});\n${line("2026-10-4", [paper(2)])}`,
		code: 1,
		stderr: ["line 2: doesn't load", "line 3: date must be YYYY-MM-DD"],
	},
	{
		name: "check on a missing file",
		args: ["check", "FILE"],
		digests: null,
		code: 1,
		stderr: ["doesn't exist"],
	},
	{
		name: "check on a file of papers the site holds",
		args: ["check", "FILE"],
		digests: line("2026-10-11", [
			{
				...paper(1),
				figure: {
					src: "https://arxiv.org/html/2601.00001v1/x1.png",
					caption: "Figure 1: A plot.",
					from: "https://arxiv.org/html/2601.00001v1",
				},
			},
			{
				id: "doi:10.56553/popets-2026-0038",
				type: "paper",
				title: "Fixture proceedings paper",
				authors: ["Ada Example"],
				published: "2026-10-11",
				source: "PoPETs",
				url: "https://petsymposium.org/popets/2026/popets-2026-0038.php",
				links: [
					{
						label: "PDF",
						url: "https://petsymposium.org/popets/2026/popets-2026-0038.pdf",
					},
				],
				abstract: "We report what we measured.",
				venue: "PETS 2026",
				venue_source: "https://petsymposium.org/2026/paperlist.php",
			},
			storedNews(3),
		]),
		code: 0,
		stdout: ["ok: 1 lines, 3 entries\n"],
	},
	// status
	{
		name: "status counts today's papers, not the ad hoc ones",
		args: ["status", "FILE"],
		digests:
			line(TODAY, [paper(2), paper(3), paper(4)]) +
			line(
				TODAY,
				[5, 6, 7].map((n) => ({ ...paper(n), ad_hoc: true })),
			) +
			line("2026-10-19", [paper(8)]),
		code: 0,
		stdout: ["papers today: 3\n", "surprise today: no\n"],
	},
	{
		name: "status on a file that doesn't exist yet",
		args: ["status", "FILE"],
		digests: null,
		code: 0,
		stdout: ["papers today: 0\n", "surprise today: no\n"],
	},
	{
		name: "status --date counts that day",
		args: ["status", "--date", "2026-10-18", "FILE"],
		digests: line("2026-10-18", [paper(2), paper(3)]) + line(TODAY, [paper(4)]),
		code: 0,
		stdout: [
			"today: 2026-10-18 (Asia/Jakarta, set by --date)\n",
			"papers today: 2\n",
		],
	},
	// wrong arguments
	...[
		[],
		["status"],
		["add", "digests.js"],
		["count", "digests.js"],
		["status", "--date", "digests.js"],
		["check", "--date", "2026-10-10", "digests.js"],
		["status", "--date", "2026-10-10", "--date", "2026-10-11", "digests.js"],
		["status", "--ad-hoc", "digests.js"],
	].map(
		(args): Row => ({
			name: `the arguments ${JSON.stringify(args)}`,
			args: args,
			code: 1,
			stderr: ["usage: node scripts/digests/digests.ts"],
		}),
	),
];

describe("commands that write nothing", () => {
	test("privacy: each gives its expected output and exit code, never quotes a file's text, and leaves the digests file as it was", async () => {
		const outcomes = await Promise.all(
			ROWS.map(async (row, k) => {
				const sub = join(folder, `row-${k}`);
				mkdirSync(sub);
				const file = join(sub, "digests.js");
				let held: string | null = null;
				if (row.digests !== null) {
					held = row.digests === undefined ? OLD_LINE : row.digests;
					writeFileSync(file, held);
				}
				const items = join(sub, "items.json");
				if (row.items !== undefined) {
					writeFileSync(
						items,
						typeof row.items === "string"
							? row.items
							: JSON.stringify(row.items),
					);
				}
				const args = row.args.map((arg) => {
					if (arg === "FILE") return file;
					if (arg === "ITEMS") return items;
					return arg;
				});
				const result = await digests(args);
				let after: string | null = null;
				try {
					after = readFileSync(file, "utf8");
				} catch {
					after = null;
				}
				return { row: row, result: result, held: held, after: after };
			}),
		);
		for (const { row, result, held, after } of outcomes) {
			expect(result.code, `${row.name}: exit code`).toBe(row.code);
			for (const said of row.stdout || []) {
				expect(result.stdout, `${row.name}: stdout`).toContain(said);
			}
			for (const said of row.stderr || []) {
				expect(result.stderr, `${row.name}: stderr`).toContain(said);
			}
			for (const never of row.never || []) {
				expect(
					result.stdout + result.stderr,
					`${row.name}: never`,
				).not.toContain(never);
			}
			expect(after, `${row.name}: the digests file`).toBe(held);
		}
	});

	test("the program runs when started through a symbolic link", async () => {
		const link = join(folder, "digests-link.ts");
		symlinkSync(SCRIPT.pathname, link);
		const file = fileWith("digests.js", line(TODAY, [paper(2), paper(3)]));
		const result = await digests(["status", file], link);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("papers today: 2\n");
	});
});
