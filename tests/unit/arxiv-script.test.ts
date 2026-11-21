// Unit tests for the program scripts/scout/arxiv/arxiv.ts, run as the scout runs it, against stand-ins for arXiv's API and OAI-PMH on
// 127.0.0.1 that serve the answers saved in tests/fixtures. Nothing here contacts arXiv. Each run covers many rules at
// once (a call with several ids that each go wrong in their own way); the commands that are refused before arXiv is
// asked run side by side.
import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { isArxivId } from "../../shared/arxiv-id.ts";
import { allowLocal, closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/scout/arxiv/arxiv.ts", import.meta.url);
const run = promisify(execFile);
const TODAY = "2026-10-20";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-arxiv-script-"));
let folder = "";
let counter = 0;

beforeEach(() => {
	counter += 1;
	folder = join(WORK, `run-${counter}`);
	mkdirSync(folder);
});
afterEach(closeServers);
afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

const fixture = (name: string) =>
	readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// The ids the API stand-in has a saved entry for.
const API_FILES: Record<string, string> = {
	"2507.11473": "arxiv-2507.11473.xml",
	"1706.03762": "arxiv-1706.03762.xml",
	"hep-th/9901001": "arxiv-hep-th-9901001.xml",
};

type Reply = { status: number; body: string };
type Asked = { api: string[][]; oai: string[] };
type Change = (xml: string) => string;

type Behaviour = {
	// Ids that have an entry made from 2507.11473's, each with a change to it (the API's entry, the OAI-PMH record).
	made?: Record<
		string,
		{ entry?: Change; record?: Change; published?: string }
	>;
	rejects?: string[]; // ids the API answers HTTP 400 for
	api?: () => Reply; // a reply in place of the feed
	oai?: (id: string) => Reply | undefined; // a reply in place of a saved record
};

// The saved API entry for an id, or one made from 2507.11473's; null when the stand-in has none.
function entryOf(id: string, behaviour: Behaviour) {
	let source = "";
	if (id in API_FILES) {
		source = fixture(API_FILES[id] as string);
	} else if (behaviour.made?.[id] !== undefined) {
		source = fixture("arxiv-2507.11473.xml").replaceAll("2507.11473", id);
	} else {
		return null;
	}
	let entry = (source.match(/<entry>[\s\S]*<\/entry>/) as RegExpMatchArray)[0];
	const made = behaviour.made?.[id];
	if (made?.published !== undefined) {
		entry = entry.replace(
			/<published>[^<]*<\/published>/,
			`<published>${made.published}T00:00:00Z</published>`,
		);
	}
	if (made?.entry !== undefined) {
		entry = made.entry(entry);
	}
	return entry;
}

// One feed holding the saved entry of every id the stand-in has, sorted by id, as arXiv answers.
function feedFor(ids: string[], behaviour: Behaviour) {
	const head = fixture("arxiv-2507.11473.xml").split("<entry>")[0] as string;
	const entries = ids
		.toSorted()
		.map((id) => entryOf(id, behaviour))
		.filter((entry) => entry !== null);
	return `${head}${entries.join("\n")}\n</feed>\n`;
}

// The saved OAI-PMH record of an id in a format, or one made from 2507.11473's; "idDoesNotExist" for any other id.
function oaiRecord(id: string, format: string, behaviour: Behaviour) {
	if (id === "2507.11473" || id === "1706.03762") {
		return fixture(`oai-${id}-${format}.xml`);
	}
	const made = behaviour.made?.[id];
	if (made === undefined) {
		return fixture("oai-2507.99999-idDoesNotExist.xml");
	}
	let record = fixture(`oai-2507.11473-${format}.xml`).replaceAll(
		"2507.11473",
		id,
	);
	if (made.record !== undefined && format === "arXiv") {
		record = made.record(record);
	}
	return record;
}

// An OAI-PMH error answer with a code and a reason.
const oaiError = (code: string, reason: string) =>
	`<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="${code}">${reason}</error></OAI-PMH>`;

// Stand-ins for arXiv's API (at /api) and OAI-PMH (at /oai); their addresses, and what they were asked.
async function standIn(behaviour: Behaviour = {}) {
	const asked: Asked = { api: [], oai: [] };
	const base = await serve((incoming, out) => {
		const url = new URL(incoming.url as string, "http://stand-in.test");
		if (url.pathname === "/api") {
			const ids = (url.searchParams.get("id_list") as string).split(",");
			asked.api.push(ids);
			const rejected = ids.find((id) => behaviour.rejects?.includes(id));
			let reply: Reply = { status: 200, body: feedFor(ids, behaviour) };
			if (rejected !== undefined) {
				reply = {
					status: 400,
					body: fixture("arxiv-error-400.xml").replaceAll(
						"not-an-id",
						rejected,
					),
				};
			}
			if (behaviour.api !== undefined) {
				reply = behaviour.api();
			}
			out.writeHead(reply.status, { "content-type": "application/atom+xml" });
			out.end(reply.body);
			return;
		}
		asked.oai.push(incoming.url as string);
		const id = (url.searchParams.get("identifier") as string).replace(
			"oai:arXiv.org:",
			"",
		);
		if (!isArxivId(id)) {
			out.end(oaiError("badArgument", "not an arXiv id"));
			return;
		}
		const instead = behaviour.oai?.(id);
		if (instead !== undefined) {
			out.writeHead(instead.status);
			out.end(instead.body);
			return;
		}
		const format = url.searchParams.get("metadataPrefix");
		if (format !== "arXiv" && format !== "arXivRaw") {
			out.end(oaiError("cannotDisseminateFormat", "format not supported"));
			return;
		}
		out.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
		out.end(oaiRecord(id, format, behaviour));
	});
	return { api: `${base}/api`, oai: `${base}/oai`, asked: asked };
}

// An address nothing listens on, for a service that can't be reached.
async function closedAddress() {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	allowLocal(address.port);
	return `http://127.0.0.1:${address.port}`;
}

type Result = { code: number; stdout: string; stderr: string };

// arxiv.ts with the given arguments, its API and OAI-PMH addresses set, run in the run's own folder.
async function arxiv(
	args: string[],
	addresses: { api: string; oai: string },
	script: string = SCRIPT.pathname,
): Promise<Result> {
	try {
		const done = await run(process.execPath, [script, ...args], {
			cwd: folder,
			env: {
				...process.env,
				ARXIV_API: addresses.api,
				ARXIV_OAI: addresses.oai,
				ARXIV_PAUSE_MS: "1",
				LIMINAL_TODAY: TODAY,
				TMPDIR: WORK,
			},
			timeout: 60_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

const OLD_LINE =
	'digest({"date":"2026-10-01","entries":[{"id":"arxiv:2601.09999","type":"paper","title":"Old paper","authors":["Ada Example"],"published":"2026-01-02"}]});';
const KEPT_LINE =
	'digest({"date":"2026-10-02","entries":[{"id":"arxiv:2507.11473","type":"paper","title":"Kept","authors":["Ada Example"],"published":"2025-07-15"}]});';

// The digests file of the run, holding `content`; its path.
function digestsFile(content: string | null = `${OLD_LINE}\n`) {
	const file = join(folder, "digests.js");
	if (content !== null) {
		writeFileSync(file, content);
	}
	return file;
}

type Line = { date: string; entries: Record<string, unknown>[] };

function lineOf(text: string): Line {
	const match = text.match(/^digest\((.*)\);$/);
	expect(match, `a digest line, got ${text}`).not.toBeNull();
	return JSON.parse((match as RegExpMatchArray)[1] as string);
}

const linesOf = (file: string): Line[] =>
	readFileSync(file, "utf8").trimEnd().split("\n").map(lineOf);

const idsOf = (line: Line) => line.entries.map((entry) => entry.id);

describe("what a call writes", () => {
	test("a preview prints the papers as one line in the order given and names each repeated, malformed or empty id", async () => {
		const stand = await standIn();
		const result = await arxiv(
			[
				"2507.11473",
				"hep-th/9901001",
				"arxiv:1706.03762v7",
				"arxiv:2507.11473v2",
				"not-an-id",
				"",
			],
			stand,
		);
		expect(result.code).toBe(1);
		expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
		const line = lineOf(result.stdout.trimEnd());
		expect(line.date).toBe(TODAY);
		expect(idsOf(line)).toEqual([
			"arxiv:2507.11473",
			"arxiv:hep-th/9901001",
			"arxiv:1706.03762",
		]);
		expect(line.entries[1]?.url).toBe("https://arxiv.org/abs/hep-th/9901001");
		expect(line.entries[1]?.links).toEqual([
			{ label: "PDF", url: "https://arxiv.org/pdf/hep-th/9901001" },
		]);
		for (const entry of line.entries) {
			for (const key of [
				"pick",
				"pick_source",
				"venue",
				"venue_source",
				"ad_hoc",
			]) {
				expect(entry).not.toHaveProperty(key);
			}
		}
		expect(result.stderr).toContain('not an arXiv id: not-an-id, ""');
		expect(stand.asked.api).toEqual([
			["2507.11473", "hep-th/9901001", "1706.03762"],
		]);
		expect(stand.asked.oai).toEqual([]);
	});

	test("--pick, --venue and --ad-hoc, written with = or with a space, add their fields after arXiv's fields and change nothing else", async () => {
		const stand = await standIn();
		const plain = await arxiv(["2507.11473", "1706.03762"], stand);
		const marked = await arxiv(
			[
				"--pick=surprise",
				"--pick-source",
				"https://www.quantamagazine.org/x/",
				"--venue",
				"AIES 2026",
				"--venue-source=https://www.aies-conference.com/2026/paper-sessions/",
				"--ad-hoc",
				"2507.11473",
				"1706.03762",
			],
			stand,
		);
		const before = lineOf(plain.stdout.trimEnd()).entries;
		const after = lineOf(marked.stdout.trimEnd()).entries;
		for (const entry of after) {
			expect(Object.keys(entry).slice(-5)).toEqual([
				"pick",
				"pick_source",
				"venue",
				"venue_source",
				"ad_hoc",
			]);
			expect(entry).toMatchObject({
				pick: "surprise",
				pick_source: "https://www.quantamagazine.org/x/",
				venue: "AIES 2026",
				venue_source: "https://www.aies-conference.com/2026/paper-sessions/",
				ad_hoc: true,
			});
		}
		expect(
			after.map((entry) => {
				const { pick, pick_source, venue, venue_source, ad_hoc, ...rest } =
					entry;
				return rest;
			}),
		).toEqual(before);
	});
});

describe("appending to the digests file", () => {
	test("one call appends only the papers that arrived, under the --date day, and names why each other id was skipped", async () => {
		const incomplete = (change: Change) => ({ entry: change });
		const stand = await standIn({
			rejects: ["2601.00001"],
			made: {
				"2601.00001": {},
				"2601.00003": incomplete((entry) =>
					entry.replace(/<title>[\s\S]*?<\/title>/, "<title></title>"),
				),
				"2601.00004": incomplete((entry) =>
					entry.replace(/<author>[\s\S]*?<\/author>/g, ""),
				),
				"2601.00005": incomplete((entry) =>
					entry.replace(/<published>[^<]*<\/published>/, ""),
				),
				"2601.00006": incomplete((entry) =>
					entry.replace(/<name>[^<]*<\/name>/, "<name></name>"),
				),
				"2601.00007": incomplete((entry) =>
					entry.replace(
						/<published>[^<]*<\/published>/,
						"<published>soon</published>",
					),
				),
				"2601.00008": { published: "2026-10-19" },
			},
		});
		const file = digestsFile(`${OLD_LINE}\n${KEPT_LINE}\n`);
		const ids = [
			"2507.11473",
			"1706.03762",
			"2601.00001",
			"2507.99999",
			"2601.00003",
			"2601.00004",
			"2601.00005",
			"2601.00006",
			"2601.00007",
			"2601.00008",
			"not-an-id",
			"",
		];
		const result = await arxiv(
			["--append", file, "--date", "2026-10-17", ...ids],
			stand,
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe(
			"appended arxiv:1706.03762 Attention Is All You Need\n" +
				`appended 1 paper to ${file}\n`,
		);
		const lines = linesOf(file);
		expect(lines).toHaveLength(3);
		expect(lines[2]?.date).toBe("2026-10-17");
		expect(idsOf(lines[2] as Line)).toEqual(["arxiv:1706.03762"]);
		expect(
			readFileSync(file, "utf8").startsWith(`${OLD_LINE}\n${KEPT_LINE}\n`),
		).toBe(true);
		for (const said of [
			`already in ${file}, skipped: 2507.11473`,
			'not an arXiv id: not-an-id, ""',
			"rejected by arXiv: 2601.00001",
			"not found on arXiv: 2507.99999",
			"incomplete on arXiv, missing its title: 2601.00003",
			"incomplete on arXiv, missing its authors: 2601.00004",
			"incomplete on arXiv, missing its date: 2601.00005",
			"incomplete on arXiv, missing its authors: 2601.00006",
			"incomplete on arXiv, missing its date: 2601.00007",
			"arxiv:2601.00008 was first submitted on 2026-10-19, after 2026-10-17",
		]) {
			expect(result.stderr).toContain(said);
		}
		// The rejected id is dropped and the rest asked again.
		expect(stand.asked.api).toHaveLength(2);
		expect(stand.asked.api[0]).toContain("2601.00001");
		expect(stand.asked.api[1]).not.toContain("2601.00001");
		expect(stand.asked.api[0]).not.toContain("2507.11473");
	});

	test("a missing file is created, and a second call for the same papers fails without asking arXiv", async () => {
		const stand = await standIn();
		const file = digestsFile(null);
		const first = await arxiv(
			["--append", file, "2507.11473", "1706.03762"],
			stand,
		);
		expect(first.code).toBe(0);
		expect(first.stdout).toBe(
			"appended arxiv:2507.11473 Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety\n" +
				"appended arxiv:1706.03762 Attention Is All You Need\n" +
				`appended 2 papers to ${file}\n`,
		);
		expect(linesOf(file)).toHaveLength(1);
		const held = readFileSync(file, "utf8");
		const asked = stand.asked.api.length;
		const again = await arxiv(
			["--append", file, "arxiv:2507.11473v2", "1706.03762"],
			stand,
		);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("already in");
		expect(again.stderr).toContain("2507.11473, 1706.03762");
		expect(readFileSync(file, "utf8")).toBe(held);
		expect(stand.asked.api).toHaveLength(asked);
	});

	test("a file whose last line has no line break gets one before the new line", async () => {
		const stand = await standIn();
		const last = OLD_LINE.slice(0, -1);
		const file = digestsFile(last);
		await arxiv(["--append", file, "2507.11473"], stand);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(last);
		expect(idsOf(lineOf(lines[1] as string))).toEqual(["arxiv:2507.11473"]);
	});
});

describe("when arXiv's API fails", () => {
	test("OAI-PMH supplies the papers, and each paper it cannot give is named with the reason", async () => {
		const stand = await standIn({
			api: () => ({ status: 429, body: "Rate exceeded." }),
			made: {
				"2601.00001": {},
				"2601.00002": {},
				"2601.00003": {
					record: (record) =>
						record.replace(/<title>[\s\S]*?<\/title>/, "<title></title>"),
				},
			},
			oai: (id) => {
				if (id === "2601.00001") {
					return { status: 503, body: "" };
				}
				if (id === "2601.00002") {
					return {
						status: 200,
						body: oaiError("badArgument", "The argument is bad"),
					};
				}
				return undefined;
			},
		});
		const file = digestsFile();
		const result = await arxiv(
			[
				"--append",
				file,
				"2507.11473",
				"2601.00001",
				"2601.00002",
				"2601.00003",
				"2507.99999",
				"1706.03762",
			],
			stand,
		);
		expect(result.code).toBe(1);
		expect(idsOf(linesOf(file)[1] as Line)).toEqual([
			"arxiv:2507.11473",
			"arxiv:1706.03762",
		]);
		const first = `${stand.oai}?verb=GetRecord&metadataPrefix=arXiv&identifier=oai:arXiv.org:2601.00001`;
		for (const said of [
			'arXiv API answered HTTP 429 "Rate exceeded."',
			"fetching 6 papers from OAI-PMH instead",
			`not fetched because OAI-PMH answered HTTP 503: 2601.00001 (${first}). The other papers were appended; run the same command again later for these ids.`,
			'not fetched because OAI-PMH answered with error badArgument "The argument is bad"',
			"asking again won't help; check https://arxiv.org/abs/2601.00002",
			"incomplete on arXiv, missing its title: 2601.00003",
			"not found on arXiv: 2507.99999",
		]) {
			expect(result.stderr).toContain(said);
		}
	});

	test.each([
		[
			"a page that isn't a feed",
			{ status: 200, body: "<html>log in to the Wi-Fi</html>" },
			"arXiv API answered with something that isn't an arXiv feed",
		],
		["HTTP 503", { status: 503, body: "" }, "arXiv API answered HTTP 503"],
	])(
		"OAI-PMH supplies the papers when the API answers %s",
		async (_what, reply, said) => {
			const stand = await standIn({ api: () => reply });
			const file = digestsFile();
			const result = await arxiv(
				["--append", file, "2507.11473", "1706.03762"],
				stand,
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toContain(said);
			expect(idsOf(linesOf(file)[1] as Line)).toEqual([
				"arxiv:2507.11473",
				"arxiv:1706.03762",
			]);
			expect(stand.asked.oai).toHaveLength(4);
		},
	);

	test("OAI-PMH supplies the papers when the API can't be reached", async () => {
		const stand = await standIn();
		const closed = await closedAddress();
		const file = digestsFile();
		const result = await arxiv(["--append", file, "2507.11473"], {
			api: `${closed}/api`,
			oai: stand.oai,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("arXiv API could not be reached");
		expect(idsOf(linesOf(file)[1] as Line)).toEqual(["arxiv:2507.11473"]);
	});

	test("when OAI-PMH fails too, nothing is appended and the run says to try the same command later", async () => {
		const stand = await standIn({
			api: () => ({ status: 429, body: "Rate exceeded." }),
			oai: () => ({ status: 503, body: "" }),
		});
		const file = digestsFile();
		const result = await arxiv(
			["--append", file, "2507.11473", "1706.03762"],
			stand,
		);
		expect(result.code).toBe(1);
		expect(readFileSync(file, "utf8")).toBe(`${OLD_LINE}\n`);
		expect(result.stderr).toContain(
			'arXiv API answered HTTP 429 "Rate exceeded."',
		);
		expect(result.stderr).toContain(
			"Nothing was appended: arXiv is overloaded or unreachable; run the same command again later; ids already in the file are skipped.",
		);
	});

	test("an HTTP 400 that names no id fails the run, and the file is untouched", async () => {
		const stand = await standIn({
			api: () => ({ status: 400, body: fixture("arxiv-error-400-no-id.xml") }),
		});
		const file = digestsFile();
		const result = await arxiv(["--append", file, "2507.11473"], stand);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("arXiv API answered HTTP 400");
		expect(readFileSync(file, "utf8")).toBe(`${OLD_LINE}\n`);
	});
});

// A command that is refused before arXiv is asked: what it is, its arguments, and what it says. FILE, MISSING, NOTES,
// FOLDER and READONLY stand for paths the test makes.
const REFUSED: [string, string[], string][] = [
	[
		"an unknown option",
		["--pik", "surprise"],
		'unknown option "--pik". usage: node scripts/scout/arxiv/arxiv.ts',
	],
	[
		"a pick other than surprise",
		["--pick", "favourite"],
		'--pick accepts only "surprise"',
	],
	[
		"--append given twice",
		["--append", "FILE", "--append=other.js"],
		'"--append" is given more than once',
	],
	[
		"--venue given twice",
		["--venue", "A", "--venue-source", "https://a.org/x", "--venue", "B"],
		'"--venue" is given more than once',
	],
	[
		"--pick given last with no value",
		["--append", "FILE", "2507.11473", "--pick"],
		"--pick",
	],
	[
		"--append followed by an option",
		["--append", "--pick", "surprise", "2507.11473"],
		"--append",
	],
	[
		"--venue without its source",
		["--venue", "ICML"],
		"--venue and --venue-source go together",
	],
	[
		"a source without its venue",
		["--venue-source", "https://icml.cc/a"],
		"--venue and --venue-source go together",
	],
	[
		"a blank venue",
		["--venue", " ", "--venue-source", "https://icml.cc/a"],
		"--venue needs a venue name",
	],
	[
		"a venue source that is not a web address",
		["--venue", "A", "--venue-source", "javascript:alert(1)"],
		'--venue-source must be an http or https URL, got "javascript:alert(1)"',
	],
	[
		"a pick source without a pick",
		["--pick-source", "https://a.example/1"],
		"--pick-source needs --pick surprise",
	],
	[
		"a pick source with no host",
		["--pick", "surprise", "--pick-source", "https://"],
		"--pick-source must be an http or https URL",
	],
	[
		"an arXiv id where the file belongs",
		["--append", "1706.03762"],
		'--append needs a file, but got "1706.03762"',
	],
	["a --date after today", ["--date", "2026-10-21"], "--date is after today"],
	[
		"a --date more than 7 days back",
		["--date", "2026-10-12"],
		"--date is more than 7 days before today",
	],
	[
		"a file in a folder that doesn't exist",
		["--append", "MISSING/digests.js"],
		"its folder does not exist",
	],
	[
		"a file in a folder that is really a file",
		["--append", "NOTES/digests.js"],
		"its folder is not a folder",
	],
	["a folder in place of the file", ["--append", "FOLDER"], "it is a folder"],
	["a read-only file", ["--append", "READONLY"], "it can't be written"],
	[
		"only ids that aren't arXiv ids",
		["--append", "FILE", "not-an-id"],
		"not an arXiv id: not-an-id",
	],
];

describe("a command line the program refuses", () => {
	test("a refused command says why and fails without asking arXiv or changing a file", async () => {
		const stand = await standIn();
		const file = digestsFile();
		const other = join(folder, "other.js");
		writeFileSync(other, `${OLD_LINE}\n`);
		writeFileSync(join(folder, "notes.txt"), "x");
		const readOnly = join(folder, "ro.js");
		writeFileSync(readOnly, OLD_LINE);
		chmodSync(readOnly, 0o444);
		const paths: Record<string, string> = {
			FILE: file,
			MISSING: join(folder, "missing"),
			NOTES: join(folder, "notes.txt"),
			FOLDER: folder,
			READONLY: readOnly,
		};
		const results = await Promise.all(
			REFUSED.map(async ([, options, said]) => {
				const args = options.map((option) => {
					let text = option;
					for (const [name, path] of Object.entries(paths)) {
						text = text.replace(name, path);
					}
					return text;
				});
				if (
					!args.some((arg) => /^(\d{4}\.\d{5}|--append|not-an-id)/.test(arg))
				) {
					args.push("2507.11473");
				}
				return { said: said, result: await arxiv(args, stand) };
			}),
		);
		results.forEach(({ said, result }, k) => {
			const what = REFUSED[k]?.[0];
			expect(result.code, `${what}: exit code`).toBe(1);
			expect(result.stderr, `${what}: message`).toContain(said);
		});
		expect(stand.asked.api).toHaveLength(0);
		expect(readFileSync(file, "utf8")).toBe(`${OLD_LINE}\n`);
		expect(readFileSync(other, "utf8")).toBe(`${OLD_LINE}\n`);
		expect(existsSync(join(folder, "1706.03762"))).toBe(false);
	});

	test("the program runs when started through a symbolic link", async () => {
		const stand = await standIn();
		const link = join(folder, "arxiv-link.ts");
		symlinkSync(SCRIPT.pathname, link);
		const result = await arxiv(["2507.11473"], stand, link);
		expect(idsOf(lineOf(result.stdout.trimEnd()))).toEqual([
			"arxiv:2507.11473",
		]);
	});
});
