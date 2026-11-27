// Append a paper that has no arXiv id from its own metadata, once Crossref's record (with a DOI) or its page (without)
// agrees with it.
// Usage: node scripts/scout/web/paper.ts --append <digests file> [--date YYYY-MM-DD]
//        [--pick surprise --pick-source <url>] <paper json file>
// The file holds one PaperClaim as JSON. A claim with a DOI is checked against Crossref's record for the DOI (the same
// title and first author's surname), and its page is not opened; a claim without one is checked against its page,
// which must load and hold the title and the first author's surname. The address must be https and public either way,
// and the run prints which evidence it used.
// Environment: CROSSREF_API (stand-in for Crossref, tests only); LIMINAL_TODAY (YYYY-MM-DD) is taken as today in Asia/Jakarta,
// tests only.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { normalizeId } from "../../../shared/arxiv-id.ts";
import { entryProblems } from "../../../shared/entry-checks.ts";
import { errorCode, isJsonObject } from "../../../shared/narrow.ts";
import {
	appendDigestLine,
	idsInText,
	readDigestsText,
} from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { htmlToText } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";
import { FetchRefused, publicAddress } from "../../lib/public-address.ts";
import {
	jakartaToday,
	runDateProblem,
	takeDateOption,
} from "../../lib/run-date.ts";
import { normaliseTitle } from "../plan/title-match.ts";
import {
	crossrefPaper,
	pagePaper,
	proceedingsEntry,
	siteOf,
} from "../proceedings/sites.ts";

const fail: Fail = failer("paper.ts");

const USAGE =
	"usage: node scripts/scout/web/paper.ts --append <digests file> [--date YYYY-MM-DD] " +
	"[--pick surprise --pick-source <url>] <paper json file>";

// What the scout or the connector gives for one paper.
export type PaperClaim = {
	title: string;
	authors: string[];
	venue: string;
	url: string;
	doi?: string;
	abstract?: string;
};

// The arXiv paper a claim's address or DOI names ("an arXiv id 2507.11473", or the arXiv address), or null for none.
function arxivPaperOf(claim: PaperClaim): string | null {
	const fromDoi = claim.doi?.match(/^10\.48550\/arxiv\.(.+)$/i);
	if (fromDoi?.[1] !== undefined) {
		return `the arXiv id ${normalizeId(fromDoi[1])}`;
	}
	const page = URL.parse(claim.url);
	if (page === null || !/(^|\.)arxiv\.org$/i.test(page.hostname)) {
		return null;
	}
	const fromPath = page.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/);
	if (fromPath?.[1] !== undefined) {
		return `the arXiv id ${normalizeId(fromPath[1])}`;
	}
	return `the arXiv address ${claim.url}`;
}

// A name's words as the surname check compares them: accents and case dropped, split at anything but a letter.
function nameWords(name: string): string[] {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((word) => word !== "");
}

// The surname of "Given Family" or "Family, Given": its last word, or the one before the comma.
function surnameOf(name: string): string | undefined {
	return nameWords(name.split(",")[0] || "").at(-1);
}

// What is wrong with the page: it answered an error status, or it lacks the title or the first author's surname,
// in its text or in its citation_title and citation_author tags.
async function pageProblems(claim: PaperClaim): Promise<string[]> {
	const answer = await request(claim.url);
	if ("problem" in answer) {
		return [`page check: ${claim.url} ${answer.problem}`];
	}
	if (!answer.ok) {
		return [`page check: ${claim.url} answered HTTP ${answer.status}`];
	}
	const html = answer.text();
	const meta = pagePaper(html, claim.url);
	const problems: string[] = [];
	const title = ` ${normaliseTitle(claim.title)} `;
	const titles = [htmlToText(html), meta?.title ?? ""].map(
		(text) => ` ${normaliseTitle(text)} `,
	);
	if (!titles.some((text) => text.includes(title))) {
		problems.push(
			`title check: the page doesn't hold the title "${claim.title}"`,
		);
	}
	const surname = surnameOf(claim.authors[0] || "");
	const names = new Set(
		[htmlToText(html), ...(meta?.authors ?? [])].flatMap(nameWords),
	);
	if (surname === undefined || !names.has(surname)) {
		problems.push(
			`author check: the page doesn't hold the first author's surname "${surname ?? ""}"`,
		);
	}
	return problems;
}

// What is wrong with the claim against Crossref's record for its DOI: the record is missing, or its title or first
// author is another. The paper's page is not opened.
async function crossrefProblems(
	claim: PaperClaim,
	doi: string,
): Promise<string[]> {
	// A DOI is the same in any case; Crossref keeps it in lower case.
	const answer = await crossrefPaper(doi.toLowerCase(), false);
	if ("problem" in answer) {
		return [`Crossref check: Crossref ${answer.problem}`];
	}
	if ("missing" in answer) {
		return [`Crossref check: the record for ${doi} is ${answer.missing}`];
	}
	const problems: string[] = [];
	const recordTitle = String(answer.entry.title);
	// The title alone, or followed by the subtitle Crossref keeps in a field of its own.
	const recordTitles = [recordTitle, `${recordTitle} ${answer.subtitle}`];
	if (
		!recordTitles.some(
			(title) => normaliseTitle(title) === normaliseTitle(claim.title),
		)
	) {
		let shown = recordTitle;
		if (answer.subtitle !== "") {
			shown = `${recordTitle}: ${answer.subtitle}`;
		}
		problems.push(
			`Crossref check: the record's title is "${shown}", the claim's is "${claim.title}"`,
		);
	}
	const recordAuthor = Array.isArray(answer.entry.authors)
		? String(answer.entry.authors[0])
		: "";
	if (surnameOf(recordAuthor) !== surnameOf(claim.authors[0] || "")) {
		problems.push(
			`Crossref check: the record's first author is "${recordAuthor}", the claim's is "${claim.authors[0]}"`,
		);
	}
	return problems;
}

// The evidence claimProblems checks a claim against: Crossref's record for its DOI, else its page.
export function evidenceOf(claim: PaperClaim): string {
	if (claim.doi !== undefined) {
		return `Crossref's record for doi:${claim.doi} (the page was not opened)`;
	}
	return `the page ${claim.url}`;
}

// Each check the claim failed, as a phrase; [] when Crossref's record (with a DOI) or its page (without) agrees with it.
export async function claimProblems(claim: PaperClaim): Promise<string[]> {
	const arxiv = arxivPaperOf(claim);
	if (arxiv !== null) {
		return [`the claim holds ${arxiv}: add the paper with arxiv.ts`];
	}
	if (claim.doi !== undefined && !/^10\.\S+\/\S+$/.test(claim.doi)) {
		return [`DOI check: "${claim.doi}" is not a DOI`];
	}
	const page = URL.parse(claim.url);
	if (page === null || !/^https?:$/.test(page.protocol)) {
		return [`address check: ${claim.url} is not an https address`];
	}
	let standIn: boolean;
	try {
		standIn = (await publicAddress(claim.url)) === null;
	} catch (error) {
		if (error instanceof FetchRefused) {
			return [`address check: ${claim.url} ${error.message}`];
		}
		throw error;
	}
	// A plain http address is allowed only for a stand-in LIMINAL_ALLOW_LOCAL names.
	if (page.protocol !== "https:" && !standIn) {
		return [`address check: ${claim.url} is not an https address`];
	}
	if (claim.doi !== undefined) {
		return crossrefProblems(claim, claim.doi);
	}
	return pageProblems(claim);
}

// The paper file as a claim, or why it isn't one.
function claimFrom(text: string): PaperClaim | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "doesn't hold JSON";
	}
	if (!isJsonObject(value)) {
		return "doesn't hold a JSON object";
	}
	const { title, authors, venue, url, doi, abstract, ...rest } = value;
	const extra = Object.keys(rest);
	if (extra.length > 0) {
		return `holds fields a paper doesn't take: ${extra.join(", ")}`;
	}
	const isText = (field: unknown): field is string =>
		typeof field === "string" && field !== "";
	if (
		!isText(title) ||
		!isText(venue) ||
		!isText(url) ||
		!Array.isArray(authors) ||
		authors.length === 0 ||
		!authors.every(isText) ||
		(doi !== undefined && !isText(doi)) ||
		(abstract !== undefined && typeof abstract !== "string")
	) {
		return "needs a title, authors, a venue and a url, each as text, and a doi or an abstract only as text";
	}
	const claim: PaperClaim = { title, authors, venue, url };
	if (doi !== undefined) {
		claim.doi = doi;
	}
	if (abstract !== undefined) {
		claim.abstract = abstract;
	}
	return claim;
}

// The command line after "--append <file>": --pick and --pick-source, and the paper file; null when parseArgs
// refuses it.
function readOptions(args: string[]) {
	try {
		return parseArgs({
			args: args,
			options: {
				pick: { type: "string" },
				"pick-source": { type: "string" },
			},
			allowPositionals: true,
			strict: true,
		});
	} catch {
		return null;
	}
}

async function main(args: string[]): Promise<void> {
	const parsed = takeDateOption(args);
	if (parsed === null || parsed.rest[0] !== "--append") {
		fail(USAGE);
	}
	const file = parsed.rest[1];
	const options = readOptions(parsed.rest.slice(2));
	const paperFile = options?.positionals[0];
	if (
		file === undefined ||
		options === null ||
		paperFile === undefined ||
		options.positionals.length !== 1
	) {
		fail(USAGE);
	}
	const pick = options.values.pick;
	const pickSource = options.values["pick-source"];
	if (pick !== undefined && pick !== "surprise") {
		fail('--pick accepts only "surprise"');
	}
	if (pickSource !== undefined && pick === undefined) {
		fail("--pick-source needs --pick surprise");
	}
	if (pickSource !== undefined && !/^https?:\/\/[^\s/]+/.test(pickSource)) {
		fail(`--pick-source must be an http or https URL, got "${pickSource}"`);
	}
	const today = jakartaToday();
	let day = today;
	if (parsed.date !== null) {
		const problem = runDateProblem(parsed.date, today);
		if (problem !== null) {
			fail(problem);
		}
		day = parsed.date;
	}

	let text: string;
	try {
		text = readFileSync(paperFile, "utf8");
	} catch (error) {
		fail(`can't read ${paperFile} (${errorCode(error)})`);
	}
	const claim = claimFrom(text);
	if (typeof claim === "string") {
		fail(`${paperFile} ${claim}`);
	}
	// A DOI is the same in any case; Crossref writes it, and the digests file keeps it, in lower case.
	let id = `url:${claim.url}`;
	if (claim.doi !== undefined) {
		id = `doi:${claim.doi.toLowerCase()}`;
	}
	const existing = [...idsInText(readDigestsText(file)).other].map((known) =>
		known.toLowerCase(),
	);
	if (existing.includes(id.toLowerCase())) {
		fail(`already in ${file}, skipped: ${id}`);
	}

	const problems = await claimProblems(claim);
	if (problems.length > 0) {
		fail(`refused ${id}: ${problems.join("; ")}`);
	}
	// A paper with a DOI links to the address Crossref vouched for, not to the claim's.
	let url = claim.url;
	if (claim.doi !== undefined) {
		url = `${CONSTANTS.doiBase}/${claim.doi.toLowerCase()}`;
	}
	const entry: Record<string, unknown> = proceedingsEntry({
		id: id,
		title: claim.title,
		authors: claim.authors,
		published: "",
		abstract: claim.abstract ?? "",
		url: url,
		pdf: null,
		source: siteOf(claim.url) ?? "",
		note: claim.venue,
		venueSource: claim.url,
	});
	if (pick !== undefined) {
		entry.pick = pick;
	}
	if (pickSource !== undefined) {
		entry.pick_source = pickSource;
	}
	const entryIssues = entryProblems(entry, "check");
	if (entryIssues.length > 0) {
		fail(`refused ${id}: ${entryIssues.join("; ")}`);
	}
	try {
		appendDigestLine(file, day, [entry]);
	} catch (error) {
		fail(`can't append to ${file} (${errorCode(error)})`);
	}
	console.log(`appended ${id} ${claim.title}`);
	console.log(`checked against ${evidenceOf(claim)}`);
	console.log(`appended 1 paper to ${file}`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
