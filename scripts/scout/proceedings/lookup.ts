// Looking up the lists' papers not on arXiv in their conference's proceedings, and adding them to the pool.
import { setTimeout as pause } from "node:timers/promises";
import type { Lookup, ReadList, Run } from "../arxiv/search.ts";
import {
	daysBetween,
	NOT_ON_ARXIV_KEPT_DAYS,
	notOnArxiv,
} from "../arxiv/search.ts";
import type { Topic } from "../plan/interests.ts";
import type { Pool } from "../plan/pool.ts";
import { topicsOf } from "../plan/pool.ts";
import { normaliseTitle, titlesMatch } from "../plan/title-match.ts";
import type { IndexPaper, ProceedingsPaper, ProceedingsSite } from "./sites.ts";
import {
	indexPapers,
	ojsIssues,
	pagePaper,
	paperId,
	proceedingsOf,
} from "./sites.ts";
import { download, downloadProblem } from "./venue-lists.ts";

// Paper pages read from the proceedings sites in one run, at most; the rest wait for the next run.
const PROCEEDINGS_PAGES_PER_RUN = 30;
// The pause between two requests to the proceedings sites, which ask for no faster pace but are small sites.
const PROCEEDINGS_PAUSE_MS = Number(process.env.PROCEEDINGS_PAUSE_MS || 1000);

// One kept answer of proceedings.json, by a paper's first list name normalised: the paper found in its proceedings,
// or null for "not in the proceedings", and when it was asked.
export type ProceedingsAnswer = {
	paper: ProceedingsPaper | null;
	checked: string;
};

// True when a list paper's proceedings answer is due: never asked, or "not in the proceedings" for over 30 days.
function proceedingsDue(
	names: string[],
	kept: Record<string, ProceedingsAnswer>,
	today: string,
) {
	const answer = kept[normaliseTitle(names[0] || "")];
	if (answer === undefined) {
		return true;
	}
	if (answer.paper !== null) {
		return false;
	}
	const age = daysBetween(answer.checked, today);
	return Number.isNaN(age) || age > NOT_ON_ARXIV_KEPT_DAYS;
}

// What one run asks of the proceedings sites: whether a request was made yet (each later one waits
// PROCEEDINGS_PAUSE_MS), and how many paper pages were read.
type ProceedingsRun = { asked: boolean; pages: number };

// Download one proceedings page, after the pause when it isn't the run's first request.
async function proceedingsPage(url: string, visits: ProceedingsRun) {
	if (visits.asked) {
		await pause(PROCEEDINGS_PAUSE_MS);
	}
	visits.asked = true;
	return download(url, {});
}

// The papers of a site's index pages, in page order; [] when its proceedings aren't out (every index page answers
// 404), null when a page failed, which is named on stderr. An OJS archive leads to the issues of the list's year.
async function readIndex(
	site: ProceedingsSite,
	visits: ProceedingsRun,
	run: Run,
): Promise<IndexPaper[] | null> {
	let pages: string[] = [];
	let format = site.format;
	if (site.format === "ojs") {
		const archiveUrl = site.indexUrls[0] || "";
		const archive = await proceedingsPage(archiveUrl, visits);
		if (archive.status === 404) {
			return [];
		}
		if (!archive.ok) {
			console.error(
				`search.ts: ${site.note} proceedings (${archiveUrl}) ${downloadProblem(archive)}`,
			);
			run.failed = true;
			return null;
		}
		pages = ojsIssues(archive.body, archiveUrl, site.issueLabel || "");
		format = "ojs";
	} else {
		pages = site.indexUrls;
	}
	const papers: IndexPaper[] = [];
	for (const url of pages) {
		// biome-ignore lint/performance/noAwaitInLoops: one request at a time to a conference site, each after a pause
		const answer = await proceedingsPage(url, visits);
		if (answer.status === 404) {
			continue;
		}
		if (!answer.ok) {
			console.error(
				`search.ts: ${site.note} proceedings (${url}) ${downloadProblem(answer)}`,
			);
			run.failed = true;
			return null;
		}
		for (const paper of indexPapers(format, answer.body, url)) {
			papers.push(paper);
		}
	}
	return papers;
}

// Look for the lists' papers not on arXiv in their conference's proceedings, and keep each answer in `kept` under the
// paper's first name normalised: the paper, copied from its own page, or null for "not in the proceedings". A site's
// index is read once a run, and only when one of its titles is due; a site whose proceedings aren't out yet keeps no
// answer, so the next run asks again. At most 30 paper pages a run. Returns true when an answer was kept.
export async function lookUpProceedings(
	read: ReadList[],
	lookups: Record<string, Lookup>,
	kept: Record<string, ProceedingsAnswer>,
	today: string,
	run: Run,
): Promise<boolean> {
	const visits: ProceedingsRun = { asked: false, pages: 0 };
	const indexes = new Map<string, IndexPaper[] | null>(); // a site's index pages joined -> its papers
	let changed = false;
	for (const list of read) {
		const site = proceedingsOf(list.venue, list.url);
		if (site === null) {
			continue;
		}
		const due = list.matching.filter(
			(names) =>
				notOnArxiv(names, lookups) && proceedingsDue(names, kept, today),
		);
		if (due.length === 0) {
			continue;
		}
		const siteKey = site.indexUrls.join(" ");
		if (!indexes.has(siteKey)) {
			// biome-ignore lint/performance/noAwaitInLoops: one conference site at a time, each request after a pause
			indexes.set(siteKey, await readIndex(site, visits, run));
		}
		const index = indexes.get(siteKey);
		if (index === undefined || index === null || index.length === 0) {
			continue;
		}
		for (const names of due) {
			if (visits.pages >= PROCEEDINGS_PAGES_PER_RUN) {
				break;
			}
			const key = normaliseTitle(names[0] || "");
			const found = index.find((paper) =>
				names.some(
					(name) =>
						normaliseTitle(name) === normaliseTitle(paper.title) ||
						titlesMatch(name, paper.title),
				),
			);
			if (found === undefined) {
				kept[key] = { paper: null, checked: today };
				changed = true;
				continue;
			}
			visits.pages += 1;
			// biome-ignore lint/performance/noAwaitInLoops: one paper page at a time, each after a pause
			const answer = await proceedingsPage(found.url, visits);
			if (!answer.ok) {
				console.error(
					`search.ts: ${site.note} paper page (${found.url}) ${downloadProblem(answer)}`,
				);
				run.failed = true;
				continue;
			}
			const page = pagePaper(answer.body, found.url);
			if (page === null) {
				console.error(
					`search.ts: no paper on the ${site.note} page ${found.url}`,
				);
				run.failed = true;
				continue;
			}
			kept[key] = {
				paper: {
					id: paperId(page, found.url),
					title: page.title,
					authors: page.authors,
					published: page.published,
					abstract: page.abstract,
					url: found.url,
					pdf: page.pdf,
					source: site.source,
					note: site.note,
					venueSource: list.url,
				},
				checked: today,
			};
			changed = true;
		}
	}
	return changed;
}

// Add each list paper found in its proceedings to the pool, under its "doi:" or "url:" id, for every topic whose
// phrase one of its names holds, with its venue note and `listed` naming the venue, as addListedToPool does for list
// papers on arXiv. A paper in the digests stays out.
export function addProceedingsToPool(
	pool: Pool,
	lists: ReadList[],
	kept: Record<string, ProceedingsAnswer>,
	topics: Topic[],
	inDigests: Set<string>,
	day: string,
): void {
	for (const list of lists) {
		for (const names of list.matching) {
			const answer = kept[normaliseTitle(names[0] || "")];
			if (answer === undefined || answer.paper === null) {
				continue;
			}
			const paper = answer.paper;
			if (inDigests.has(paper.id)) {
				continue;
			}
			const known = pool[paper.id];
			let paperTopics = topicsOf(names, topics);
			let firstSeen = day;
			if (known !== undefined) {
				paperTopics = known.topics.concat(
					paperTopics.filter((topic) => !known.topics.includes(topic)),
				);
				if (known.firstSeen < day) {
					firstSeen = known.firstSeen;
				}
			}
			pool[paper.id] = Object.assign({}, known, {
				id: paper.id,
				title: paper.title,
				abstract: paper.abstract,
				authors: paper.authors,
				published: paper.published,
				note: paper.note,
				topics: paperTopics,
				firstSeen: firstSeen,
				listed: list.venue,
			});
		}
	}
}
