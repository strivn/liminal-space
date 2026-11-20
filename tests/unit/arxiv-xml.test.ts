// What each saved arXiv answer in tests/fixtures parses to, recorded as snapshots: Atom feeds, paired OAI-PMH records,
// and the error answers. Reading the XML another way must leave every snapshot as it is.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
	type ArxivAnswer,
	apiFailed,
	oaiError,
	parseFeed,
	parseOaiRecord,
	rejectedId,
	whatHappened,
} from "../../scripts/scout/arxiv/api.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const ATOM_FEEDS = [
	"arxiv-1706.03762.xml",
	"arxiv-2507.11473.xml",
	"arxiv-api-2507.11473-fresh.xml",
	"arxiv-entities.xml",
	"arxiv-hep-th-9901001.xml",
	"arxiv-venue-entities.xml",
];

// The id each saved OAI-PMH pair is for: the "arXiv" record, then the "arXivRaw" record.
const OAI_PAIRS: [string, string][] = [
	["2507.11473", "2507.11473"],
	["1706.03762", "1706.03762"],
	["2610.00003", "2610.00003"],
	["hep-th/9711200", "hep-th-9711200"],
];

test.each(ATOM_FEEDS)("The Atom answer %s parses to these papers", (name) => {
	expect(parseFeed(fixture(name))).toMatchSnapshot();
});

test.each(OAI_PAIRS)(
	"The OAI-PMH pair for %s parses to this paper",
	(id, file) => {
		const metadata = fixture(`oai-${file}-arXiv.xml`);
		const raw = fixture(`oai-${file}-arXivRaw.xml`);
		expect(parseOaiRecord(metadata, raw, id)).toMatchSnapshot();
	},
);

// An answer as arxivRequest gives it for a body and an HTTP status.
function answered(body: string, status: number): ArxivAnswer {
	return {
		url: "https://example.test/api",
		status: status,
		ok: status >= 200 && status < 300,
		body: body,
	};
}

test("The error answers are read as these ids, failures and messages", () => {
	const answers: [string, ArxivAnswer][] = [
		["400 with an id", answered(fixture("arxiv-error-400.xml"), 400)],
		["400 without an id", answered(fixture("arxiv-error-400-no-id.xml"), 400)],
		["200 feed", answered(fixture("arxiv-2507.11473.xml"), 200)],
		["200 page that is no feed", answered("<html>Log in to Wi-Fi</html>", 200)],
		["429 with a reason", answered("Rate exceeded.", 429)],
		["503 with markup", answered("<html>busy</html>", 503)],
		[
			"no answer",
			{ url: "https://example.test/api", problem: "gave no answer" },
		],
	];
	const read = answers.map(([label, answer]) => ({
		label: label,
		rejectedId: rejectedId(answer.body || ""),
		apiFailed: apiFailed(answer),
		whatHappened: whatHappened(answer, "an arXiv feed"),
	}));
	expect(read).toMatchSnapshot();
});

test("The OAI-PMH answers are read as these errors", () => {
	const names = [
		"oai-2507.99999-idDoesNotExist.xml",
		"oai-2507.11473-arXiv.xml",
		"oai-2507.11473-arXivRaw.xml",
	];
	expect(
		names.map((name) => ({ name: name, error: oaiError(fixture(name)) })),
	).toMatchSnapshot();
});

// A page that isn't XML at all (a proxy's or portal's HTML) can stop the XML reader halfway.
const BROKEN_PAGES = [
	"<html><!-- a comment that never closes",
	"<a><![CDATA[text that never closes",
];

test.each(BROKEN_PAGES)(
	"A page that isn't readable XML (%s) is read as no error, no papers and no record",
	(page) => {
		expect(oaiError(page)).toBeNull();
		expect(parseFeed(page)).toEqual([]);
		expect(parseOaiRecord(page, page, "2507.11473").published).toBe("");
	},
);
