// Unit tests for the program scripts/scout/proceedings/abstracts.ts, against a Semantic Scholar stand-in on 127.0.0.1.
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	type Ran,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const ABSTRACTS = scriptPath("scout/proceedings/abstracts.ts");
const TODAY = "2026-11-20";
const KEY = "s2-test-key-7f3a";
const ABSTRACT = "We measured how resistance exercise changes lean mass loss.";

afterEach(closeServers);
afterAll(removeTempFolders);

// A paper entry with this id.
function paper(id: string, extra: Record<string, unknown> = {}) {
	return {
		id: id,
		type: "paper",
		title: `Paper ${id}`,
		authors: ["Ada Example"],
		published: "2026-11-18",
		source: "Journal of Fixtures",
		url: `https://doi.org/${id.slice("doi:".length)}`,
		...extra,
	};
}

type Asked = { path: string; key: string | undefined };

// A Semantic Scholar stand-in answering each DOI from `answers` (status and body); 404 for any other.
async function semanticScholar(
	answers: Record<string, { status?: number; body: unknown }>,
) {
	const asked: Asked[] = [];
	const base = await serve((incoming: IncomingMessage, out) => {
		const url = new URL(incoming.url as string, "http://stand-in");
		const key = incoming.headers["x-api-key"];
		asked.push({ path: url.pathname + url.search, key: key as string });
		const doi = decodeURIComponent(url.pathname.replace(/^\/paper\/DOI:/, ""));
		const answer = answers[doi] || {
			status: 404,
			body: { error: "Paper not found" },
		};
		out.writeHead(answer.status || 200, { "content-type": "application/json" });
		out.end(JSON.stringify(answer.body));
	});
	return { base: base, asked: asked };
}

// abstracts.ts on a digests file holding `lines`; what it printed and the file's lines after.
async function fill(
	lines: string[],
	base: string,
	key: string = KEY,
): Promise<Ran & { after: string[] }> {
	const file = join(tempFolder("liminal-unit-abstracts-"), "digests.js");
	writeFileSync(file, `${lines.join("\n")}\n`);
	const ran = await runScript(ABSTRACTS, [file], {
		LIMINAL_TODAY: TODAY,
		SEMANTIC_SCHOLAR_API: base,
		SEMANTIC_SCHOLAR_API_KEY: key,
		SEMANTIC_SCHOLAR_PAUSE_MS: "0",
	});
	return { ...ran, after: readFileSync(file, "utf8").trimEnd().split("\n") };
}

describe("abstracts from Semantic Scholar", () => {
	test("a DOI paper of the run's day without an abstract gets Semantic Scholar's abstract, and the file's other lines stay as they were", async () => {
		const s2 = await semanticScholar({
			"10.1038/s41591-026-04752-5": {
				body: { paperId: "abc", abstract: `  ${ABSTRACT}\n ` },
			},
		});
		const earlier = digestText("2026-11-19", [paper("doi:10.1000/earlier")]);
		const today = digestText(TODAY, [
			paper("doi:10.1038/s41591-026-04752-5", {
				pick: "surprise",
				pick_source: "https://www.nature.com/articles/d41586-026-00001-1",
			}),
		]);
		const ran = await fill([earlier, today], s2.base);
		expect(ran.code).toBe(0);
		expect(ran.after[0]).toBe(earlier);
		const [entry] = entriesOfLine(ran.after[1] as string);
		expect(entry).toMatchObject({
			id: "doi:10.1038/s41591-026-04752-5",
			pick: "surprise",
			abstract: ABSTRACT,
		});
		expect(s2.asked).toEqual([
			{
				path: "/paper/DOI:10.1038/s41591-026-04752-5?fields=abstract",
				key: KEY,
			},
		]);
		expect(ran.stdout).toContain("added 1 abstract");
	});

	test("a paper that has an abstract, an arXiv paper and a paper of an earlier day are not asked about", async () => {
		const s2 = await semanticScholar({});
		const lines = [
			digestText("2026-11-19", [paper("doi:10.1000/earlier")]),
			digestText(TODAY, [
				paper("doi:10.1000/has", { abstract: "Crossref gave this one." }),
				paper("arxiv:2611.01234", { url: "https://arxiv.org/abs/2611.01234" }),
			]),
		];
		const ran = await fill(lines, s2.base);
		expect(ran.code).toBe(0);
		expect(s2.asked).toEqual([]);
		expect(ran.after).toEqual(lines);
	});

	test("a paper Semantic Scholar doesn't know, or knows without an abstract, is named and stays without one", async () => {
		const s2 = await semanticScholar({
			"10.1000/bare": { body: { paperId: "def", abstract: null } },
		});
		const lines = [
			digestText(TODAY, [
				paper("doi:10.1000/unknown"),
				paper("doi:10.1000/bare"),
			]),
		];
		const ran = await fill(lines, s2.base);
		expect(ran.code).toBe(0);
		expect(ran.after).toEqual(lines);
		expect(ran.stderr).toContain(
			"abstracts.ts: Semantic Scholar doesn't know doi:10.1000/unknown",
		);
		expect(ran.stderr).toContain(
			"abstracts.ts: Semantic Scholar has no abstract for doi:10.1000/bare",
		);
	});

	test("without a Semantic Scholar key nothing is asked, the missing key is named and the run exits 1", async () => {
		const s2 = await semanticScholar({});
		const lines = [digestText(TODAY, [paper("doi:10.1000/bare")])];
		const ran = await fill(lines, s2.base, "");
		expect(ran.code).toBe(1);
		expect(s2.asked).toEqual([]);
		expect(ran.after).toEqual(lines);
		expect(ran.stderr).toContain(
			"abstracts.ts: SEMANTIC_SCHOLAR_API_KEY is not set; no abstract asked for doi:10.1000/bare",
		);
	});

	test("a Semantic Scholar that refuses the key or answers an error is named, the paper stays without an abstract and the run exits 1", async () => {
		const s2 = await semanticScholar({
			"10.1000/refused": { status: 403, body: { message: "Forbidden" } },
			"10.1000/busy": { status: 429, body: { message: "Too Many Requests" } },
		});
		const lines = [
			digestText(TODAY, [
				paper("doi:10.1000/refused"),
				paper("doi:10.1000/busy"),
			]),
		];
		const ran = await fill(lines, s2.base);
		expect(ran.code).toBe(1);
		expect(ran.after).toEqual(lines);
		expect(ran.stderr).toContain(
			`abstracts.ts: Semantic Scholar answered HTTP 403 (${s2.base}/paper/DOI:10.1000/refused?fields=abstract): doi:10.1000/refused`,
		);
		expect(ran.stderr).toContain("answered HTTP 429");
	});

	test("security: the Semantic Scholar key goes only in the x-api-key header and never appears in what the run prints", async () => {
		const s2 = await semanticScholar({
			"10.1000/ok": { body: { abstract: ABSTRACT } },
			"10.1000/refused": { status: 403, body: { message: KEY } },
		});
		const ran = await fill(
			[
				digestText(TODAY, [
					paper("doi:10.1000/ok"),
					paper("doi:10.1000/refused"),
				]),
			],
			s2.base,
		);
		expect(s2.asked.map((a) => a.key)).toEqual([KEY, KEY]);
		for (const asked of s2.asked) {
			expect(asked.path).not.toContain(KEY);
		}
		expect(ran.stdout).not.toContain(KEY);
		expect(ran.stderr).not.toContain(KEY);
	});
});
