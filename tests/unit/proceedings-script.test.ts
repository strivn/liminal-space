// Unit tests for the program scripts/scout/proceedings/proceedings.ts, run as the scout runs it: the papers search.ts kept in the cache's
// proceedings.json, or Crossref's records from a stand-in on 127.0.0.1, appended to a digests file in a folder of the
// test's own. Nothing here contacts a conference site or Crossref. The runs are independent, so they all start together
// before the tests that read their outcomes.
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL(
	"../../scripts/scout/proceedings/proceedings.ts",
	import.meta.url,
);
const run = promisify(execFile);
const TODAY = "2026-10-20";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-proceedings-script-"));

type Result = { code: number; stdout: string; stderr: string };

// proceedings.ts with the given arguments in `dir`, its cache folder `dir`/cache, Crossref at `crossref` when given.
async function proceedings(
	dir: string,
	args: string[],
	crossref = "http://127.0.0.1:1",
): Promise<Result> {
	try {
		const done = await run(process.execPath, [SCRIPT.pathname, ...args], {
			cwd: dir,
			env: {
				...process.env,
				LIMINAL_TODAY: TODAY,
				LIMINAL_CACHE: join(dir, "cache"),
				CROSSREF_API: crossref,
			},
			timeout: 60_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

// A paper as proceedings.json keeps it.
function kept(n: number) {
	return {
		id: `doi:10.56553/popets-2026-000${n}`,
		title: `Fixture proceedings paper ${n}`,
		authors: ["Ada Example"],
		published: "2026-10-11",
		abstract: "We report what we measured.",
		url: `https://petsymposium.org/popets/2026/popets-2026-000${n}.php`,
		pdf: `https://petsymposium.org/popets/2026/popets-2026-000${n}.pdf`,
		source: "PoPETs",
		note: "PETS 2026",
		venueSource: "https://petsymposium.org/2026/paperlist.php",
	};
}

const OLD_LINE =
	'digest({"date":"2026-10-01","entries":[{"id":"arxiv:2601.00001","type":"paper","title":"Old","authors":["Ada Example"],"published":"2026-01-02"}]});\n';

let counter = 0;

// A folder for one run, with a digests file holding `content` and proceedings.json holding `papers` (a paper null for
// a title not found), or `json` as it is.
function setup(
	content: string,
	papers: (ReturnType<typeof kept> | null)[] = [],
	json?: string,
) {
	counter += 1;
	const dir = join(WORK, `run-${counter}`);
	mkdirSync(join(dir, "cache"), { recursive: true });
	const file = join(dir, "digests.js");
	writeFileSync(file, content);
	const answers: Record<string, unknown> = {};
	papers.forEach((paper, k) => {
		answers[`title ${k}`] = { paper: paper, checked: "2026-10-19" };
	});
	writeFileSync(
		join(dir, "cache", "proceedings.json"),
		json ?? JSON.stringify(answers),
	);
	return { dir: dir, file: file };
}

// The entries of every line the file holds after its first.
function appendedLines(file: string) {
	return readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((each) => JSON.parse(each.slice("digest(".length, -");".length)));
}

// A Crossref stand-in answering /works/<doi> with the record `records` holds under the DOI, else 404; 500 for `broken`.
async function crossrefStandIn(
	records: Record<string, unknown>,
	broken = false,
) {
	const asked: string[] = [];
	const base = await serve((incoming, out) => {
		const doi = decodeURIComponent(
			(incoming.url as string).replace("/works/", ""),
		);
		asked.push(doi);
		if (broken) {
			out.writeHead(500);
			out.end();
			return;
		}
		if (!(doi in records)) {
			out.writeHead(404);
			out.end();
			return;
		}
		out.end(JSON.stringify({ message: records[doi] }));
	});
	return { base: base, asked: asked };
}

const record = (title: string, date: number[]) => ({
	title: [title],
	author: [{ given: "Ada", family: "Example" }],
	"container-title": ["Journal of Fixtures"],
	published: { "date-parts": [date] },
});

// A command line the program refuses: what it is, its arguments (FILE for the digests file) and what it says.
const REFUSED: [string, string[], string][] = [
	[
		"nothing but a file",
		["--append", "FILE"],
		"usage: node scripts/scout/proceedings/proceedings.ts --append",
	],
	[
		"no --append",
		["doi:10.1000/abc"],
		"usage: node scripts/scout/proceedings/proceedings.ts --append",
	],
	[
		"an option it doesn't know",
		["--append", "FILE", "--pik", "x", "doi:10.1000/abc"],
		"usage: node scripts/scout/proceedings/proceedings.ts --append",
	],
	[
		"--date given twice",
		[
			"--append",
			"FILE",
			"--date",
			"2026-10-17",
			"--date",
			"2026-10-18",
			"doi:1/a",
		],
		"usage: node scripts/scout/proceedings/proceedings.ts --append",
	],
	[
		"a pick other than surprise",
		[
			"--append",
			"FILE",
			"--pick",
			"favourite",
			"doi:10.56553/popets-2026-0003",
		],
		'--pick accepts only "surprise"',
	],
	[
		"a pick source without a pick",
		[
			"--append",
			"FILE",
			"--pick-source",
			"https://a.example/1",
			"doi:10.56553/popets-2026-0003",
		],
		"--pick-source needs --pick surprise",
	],
	[
		"a pick source that is not a web address",
		[
			"--append",
			"FILE",
			"--pick",
			"surprise",
			"--pick-source",
			"javascript:alert(1)",
			"doi:10.56553/popets-2026-0003",
		],
		'--pick-source must be an http or https URL, got "javascript:alert(1)"',
	],
	[
		"a --date after today",
		[
			"--append",
			"FILE",
			"--date",
			"2026-10-21",
			"doi:10.56553/popets-2026-0003",
		],
		"--date is after today",
	],
	[
		"an id that is not a DOI with --crossref",
		["--append", "FILE", "--crossref", "url:https://example.com/p"],
		'--crossref takes only "doi:<doi>" ids, got url:https://example.com/p',
	],
];

// ---- The runs ----

const outcomes: {
	papers?: {
		first: Result;
		again: Result;
		file: string;
		afterAgain: string;
		lines: ReturnType<typeof appendedLines>;
	};
	crossref?: { result: Result; asked: string[]; file: string };
	broken?: { result: Result; base: string; file: string };
	refused?: { name: string; said: string; result: Result; file: string }[];
	unloadable?: { result: Result; file: string };
} = {};

beforeAll(async () => {
	await Promise.all([
		(async () => {
			const { dir, file } = setup(OLD_LINE, [kept(3), null]);
			const first = await proceedings(dir, [
				"--append",
				file,
				"--date",
				"2026-10-17",
				"--pick",
				"surprise",
				"--pick-source",
				"https://www.quantamagazine.org/x/",
				"doi:10.56553/popets-2026-0003",
				"doi:10.56553/popets-2026-9999",
			]);
			const afterFirst = readFileSync(file, "utf8");
			const lines = appendedLines(file);
			const again = await proceedings(dir, [
				"--append",
				file,
				"doi:10.56553/popets-2026-0003",
			]);
			outcomes.papers = {
				first: first,
				again: again,
				file: afterFirst,
				afterAgain: readFileSync(file, "utf8"),
				lines: lines,
			};
		})(),
		(async () => {
			const stand = await crossrefStandIn({
				"10.1000/abc": record("Fixture journal paper", [2026, 10, 11]),
				"10.1000/inc": { title: [], author: [] },
				"10.1000/new": record("Published too late", [2026, 10, 19]),
				"10.1000/old": record("Published in time", [2026, 10, 10]),
			});
			const { dir, file } = setup(
				`${OLD_LINE}digest({"date":"2026-10-02","entries":[{"id":"doi:10.1000/EXIST","type":"paper","title":"Kept","authors":["Ada Example"],"published":"2026-10-02"}]});\n`,
			);
			const result = await proceedings(
				dir,
				[
					"--append",
					file,
					"--date",
					"2026-10-17",
					"--crossref",
					"doi:10.1000/ABC",
					"doi:10.1000/none",
					"doi:10.1000/inc",
					"doi:10.1000/new",
					"doi:10.1000/old",
					"doi:10.1000/exist",
				],
				stand.base,
			);
			outcomes.crossref = { result: result, asked: stand.asked, file: file };
		})(),
		(async () => {
			const stand = await crossrefStandIn({}, true);
			const { dir, file } = setup(OLD_LINE);
			outcomes.broken = {
				result: await proceedings(
					dir,
					["--append", file, "--crossref", "doi:10.1000/abc"],
					stand.base,
				),
				base: stand.base,
				file: file,
			};
		})(),
		(async () => {
			outcomes.refused = await Promise.all(
				REFUSED.map(async ([name, args, said]) => {
					const { dir, file } = setup(OLD_LINE, [kept(3)]);
					const result = await proceedings(
						dir,
						args.map((arg) => (arg === "FILE" ? file : arg)),
					);
					return { name: name, said: said, result: result, file: file };
				}),
			);
		})(),
		(async () => {
			const { dir, file } = setup(OLD_LINE, [], "{not json");
			outcomes.unloadable = {
				result: await proceedings(dir, [
					"--append",
					file,
					"doi:10.56553/popets-2026-0003",
				]),
				file: file,
			};
		})(),
	]);
}, 120_000);

afterAll(async () => {
	await closeServers();
	rmSync(WORK, { recursive: true, force: true });
});

describe("papers the proceedings search saved", () => {
	test("a saved paper is appended under the --date day with the surprise mark last, and an id the search never found is named", () => {
		const o = outcomes.papers as NonNullable<typeof outcomes.papers>;
		expect(o.first.code).toBe(1);
		expect(o.first.stdout).toContain(
			"appended doi:10.56553/popets-2026-0003 Fixture proceedings paper 3\n",
		);
		expect(o.first.stdout).toContain("appended 1 paper to ");
		expect(o.first.stderr).toContain(
			"not found in the proceedings search.ts read: doi:10.56553/popets-2026-9999",
		);
		const [line] = o.lines;
		expect(line.date).toBe("2026-10-17");
		expect(line.entries).toEqual([
			{
				id: "doi:10.56553/popets-2026-0003",
				type: "paper",
				title: "Fixture proceedings paper 3",
				authors: ["Ada Example"],
				published: "2026-10-11",
				source: "PoPETs",
				url: "https://petsymposium.org/popets/2026/popets-2026-0003.php",
				links: [
					{
						label: "PDF",
						url: "https://petsymposium.org/popets/2026/popets-2026-0003.pdf",
					},
				],
				abstract: "We report what we measured.",
				venue: "PETS 2026",
				venue_source: "https://petsymposium.org/2026/paperlist.php",
				pick: "surprise",
				pick_source: "https://www.quantamagazine.org/x/",
			},
		]);
	});

	test("a paper already in the digests file is skipped and named, and the run fails with the file unchanged", () => {
		const o = outcomes.papers as NonNullable<typeof outcomes.papers>;
		expect(o.again.code).toBe(1);
		expect(o.again.stderr).toContain("already in");
		expect(o.again.stderr).toContain("doi:10.56553/popets-2026-0003");
		expect(o.afterAgain).toBe(o.file);
	});

	test("a proceedings.json that doesn't load is named, and nothing is appended", () => {
		const o = outcomes.unloadable as NonNullable<typeof outcomes.unloadable>;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain("proceedings.json doesn't load");
		expect(readFileSync(o.file, "utf8")).toBe(OLD_LINE);
	});
});

describe("--crossref", () => {
	test("--crossref appends the papers Crossref gives in the order given, and names each DOI it leaves out and why", () => {
		const o = outcomes.crossref as NonNullable<typeof outcomes.crossref>;
		expect(o.result.code).toBe(1);
		expect(o.asked).toEqual([
			"10.1000/abc",
			"10.1000/none",
			"10.1000/inc",
			"10.1000/new",
			"10.1000/old",
		]);
		const added = appendedLines(o.file).at(-1);
		expect(added.date).toBe("2026-10-17");
		expect(added.entries).toHaveLength(2);
		expect(added.entries[0]).toMatchObject({
			id: "doi:10.1000/abc",
			type: "paper",
			title: "Fixture journal paper",
			authors: ["Ada Example"],
			published: "2026-10-11",
			source: "Journal of Fixtures",
		});
		expect(added.entries[1].id).toBe("doi:10.1000/old");
		for (const said of [
			"already in",
			"doi:10.1000/exist",
			"not found on Crossref: doi:10.1000/none",
			"incomplete on Crossref, missing its title or authors: doi:10.1000/inc",
			"doi:10.1000/new was published on 2026-10-19, after 2026-10-17",
		]) {
			expect(o.result.stderr).toContain(said);
		}
	});

	test("a Crossref that answers HTTP 500 is named with its address, and nothing is appended", () => {
		const o = outcomes.broken as NonNullable<typeof outcomes.broken>;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain(
			`Crossref answered HTTP 500 (${o.base}/works/10.1000/abc): doi:10.1000/abc`,
		);
		expect(readFileSync(o.file, "utf8")).toBe(OLD_LINE);
	});
});

describe("--crossref with Semantic Scholar's abstracts", () => {
	test.todo(
		"a paper Crossref gives without an abstract gets Semantic Scholar's abstract",
	);

	test.todo(
		"Semantic Scholar is not asked about a paper whose Crossref record has an abstract",
	);

	test.todo(
		"without a Semantic Scholar key, the paper is added without an abstract and the missing key is named",
	);

	test.todo(
		"a Semantic Scholar that refuses the key or answers an error is named, and the paper is added without an abstract",
	);

	test.todo(
		"security: the Semantic Scholar key goes only in the x-api-key header and never appears in what the run prints",
	);

	test.todo(
		"a surprise pick with no abstract on Crossref or Semantic Scholar is refused and named, and nothing is appended",
	);
});

describe("a command line the program refuses", () => {
	test("a refused command says why and fails without changing the digests file", () => {
		for (const { name, said, result, file } of outcomes.refused || []) {
			expect(result.code, `${name}: exit code`).toBe(1);
			expect(result.stderr, `${name}: message`).toContain(said);
			expect(readFileSync(file, "utf8"), `${name}: the file`).toBe(OLD_LINE);
		}
	});
});
