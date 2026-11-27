// Tests of scripts/scout/proceedings/proceedings.ts --append --crossref, which adds a journal paper (the surprise) from its DOI's Crossref
// record: a Crossref stand-in on 127.0.0.1, a digests file in a temp folder, the exit code and what it prints.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import CONSTANTS from "../../scripts/lib/constants.json" with { type: "json" };
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const PROCEEDINGS = scriptPath("scout/proceedings/proceedings.ts");
const DOI = "10.1038/s41586-026-01234-5";
const STORY = "https://www.nature.com/articles/d41586-026-00001-1";

afterEach(closeServers);
afterAll(removeTempFolders);

// What Crossref's stand-in answers by DOI: a published day, or a status.
type Records = Record<string, string | number>;

// A Crossref stand-in: records by DOI, anything else HTTP 404; it keeps each request's DOI and user agent, and the most
// requests it had open at once.
async function serveCrossref(records: Records) {
	const asked: { doi: string; agent: string | undefined }[] = [];
	const state = { open: 0, mostOpen: 0 };
	const base = await serve((incoming, response) => {
		state.open += 1;
		state.mostOpen = Math.max(state.mostOpen, state.open);
		response.on("close", () => {
			state.open -= 1;
		});
		const doi = decodeURIComponent(
			String(incoming.url).slice("/works/".length),
		);
		asked.push({ doi: doi, agent: incoming.headers["user-agent"] });
		const record = records[doi];
		if (record === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (typeof record === "number") {
			response.writeHead(record);
			response.end();
			return;
		}
		const [year, month, day] = record.split("-").map(Number);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				message: {
					DOI: doi,
					title: ["Bone-derived proteins slow ageing in mice"],
					author: [{ given: "Ada", family: "Example" }],
					"container-title": ["Nature"],
					published: { "date-parts": [[year, month, day]] },
				},
			}),
		);
	});
	return { base: base, asked: asked, state: state };
}

// The file for a run: holding these lines, in its own folder.
function digestsWith(lines: string[]): string {
	const file = join(tempFolder("liminal-unit-crossref-"), "digests.js");
	writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
	return file;
}

function append(base: string, file: string, args: string[]) {
	return runScript(PROCEEDINGS, ["--append", file, "--crossref", ...args], {
		CROSSREF_API: base,
		LIMINAL_TODAY: "2026-10-12",
	});
}

test("A journal paper is appended with the surprise mark and the story it was found in", async () => {
	const { base } = await serveCrossref({ [DOI]: "2026-10-11" });
	const file = digestsWith([]);
	const ran = await append(base, file, [
		"--pick",
		"surprise",
		"--pick-source",
		STORY,
		`doi:${DOI}`,
	]);
	assert.equal(ran.code, 0, ran.stderr);
	const [entry] = entriesOfLine(
		readFileSync(file, "utf8").split("\n")[0] ?? "",
	);
	assert.equal(entry?.id, `doi:${DOI}`);
	assert.equal(entry?.pick, "surprise");
	assert.equal(entry?.pick_source, STORY);
});

test("A DOI Crossref doesn't know, or can't answer for, is named and the digests file is unchanged", async () => {
	const unknown = "10.1038/s41586-026-99999-9";
	const { base } = await serveCrossref({ [DOI]: 503 });
	const file = digestsWith([digestText("2026-10-01", [])]);
	const before = readFileSync(file, "utf8");
	const missing = await append(base, file, [`doi:${unknown}`]);
	assert.equal(missing.code, 1);
	assert.match(
		missing.stderr,
		/not found on Crossref: doi:10\.1038\/s41586-026-99999-9/,
	);
	const down = await append(base, file, [`doi:${DOI}`]);
	assert.equal(down.code, 1);
	assert.match(
		down.stderr,
		new RegExp(`Crossref answered HTTP 503 \\(${base}/works/`),
	);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("A paper published after the day being filled in is named and left out", async () => {
	const { base } = await serveCrossref({ [DOI]: "2026-10-11" });
	const file = digestsWith([]);
	const ran = await append(base, file, ["--date", "2026-10-10", `doi:${DOI}`]);
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /was published on 2026-10-11, after 2026-10-10/);
	assert.equal(readFileSync(file, "utf8"), "");
});

test("A DOI already in the digests, in capitals, is not asked for again", async () => {
	const { base, asked } = await serveCrossref({ [DOI]: "2026-10-11" });
	const file = digestsWith([
		digestText("2026-10-01", [
			{
				id: `doi:${DOI.toUpperCase()}`,
				type: "paper",
				title: "Already here",
				authors: ["Ada Example"],
				published: "2026-10-01",
				source: "Nature",
				url: `https://doi.org/${DOI}`,
				links: [],
				abstract: "Measurements.",
			},
		]),
	]);
	const ran = await append(base, file, [`doi:${DOI}`]);
	assert.match(ran.stderr, /already in .*, skipped: doi:/);
	assert.deepEqual(asked, []);
});

test("limit: Two DOIs are asked for one after the other, with the shared browser user agent and no mark of this project", async () => {
	const other = "10.1126/science.adz0001";
	const { base, asked, state } = await serveCrossref({
		[DOI]: "2026-10-11",
		[other]: "2026-10-09",
	});
	const file = digestsWith([]);
	const ran = await append(base, file, [`doi:${DOI}`, `doi:${other}`]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(
		asked.map((request) => request.doi),
		[DOI, other],
	);
	assert.equal(state.mostOpen, 1);
	for (const request of asked) {
		assert.equal(request.agent, CONSTANTS.userAgent);
		assert.equal(/liminal|@/i.test(String(request.agent)), false);
	}
});

test.todo(
	"a Crossref record with no journal, such as an SSRN paper, takes its source from the site its DOI opens",
);
