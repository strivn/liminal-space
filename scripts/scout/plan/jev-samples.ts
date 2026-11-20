// Samples of Jev's ranking for the scout's log: per topic of interests.md, the 3 highest and 3 lowest scored candidates
// of the pool, and those scored with low confidence, each with its score, confidence and whether today's digest picked
// it. The owner reads them to judge whether Jev ranks the papers they want first, day after day.
// The limits and the choice of candidates are in tests/unit/jev-samples.test.ts.
import { normalizeId } from "../../../shared/arxiv-id.ts";
import { readLines } from "../../../shared/entry-checks.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import { daysBefore } from "../../lib/run-date.ts";
import type { Pool, PoolRecord } from "./pool.ts";
import { topicWeights } from "./pool.ts";

// The highest and the lowest candidates each topic shows; a topic with twice as many or fewer shows each once.
const EACH_END = 3;
// A confidence below this is doubtful, as search.ts's DOUBTFUL_BELOW marks a line " ?".
const DOUBTFUL_BELOW = 0.5;
// search.ts offers a paper first submitted in this many days ending today, or one on a conference list (SEARCH_DAYS).
const SEARCH_DAYS = 60;
// The doubtful candidates a topic lists at most, and the characters a title keeps at most: sync.ts log refuses a log
// over 65,536 bytes, and with these a day of 8 topics stays under 20,000 bytes (tests/unit/jev-samples.test.ts).
const DOUBTFUL_LINES = 10;
const TITLE_CHARS = 90;

// Best first by Jev alone: the higher weighted score, then the higher confidence. search.ts also puts papers with a
// venue note first; the samples leave that out, since they show Jev's ranking.
function byRank(a: PoolRecord, b: PoolRecord) {
	return (
		(b.weighted || 0) - (a.weighted || 0) ||
		(b.confidence || 0) - (a.confidence || 0)
	);
}

// A title on one line, cut to TITLE_CHARS characters with "…" at the end when it was longer. Array.from splits by code
// point, so a cut never lands between the two halves of one.
function cutTitle(title: string) {
	const characters = Array.from(title.replace(/\s+/g, " ").trim());
	if (characters.length <= TITLE_CHARS) {
		return characters.join("");
	}
	return `${characters.slice(0, TITLE_CHARS - 1).join("")}…`;
}

// One sample: "- score 3.95, confidence 0.90, picked: <title>".
function sampleLine(record: PoolRecord, picked: Set<string>) {
	let confidence = "unknown";
	if (typeof record.confidence === "number") {
		confidence = record.confidence.toFixed(2);
	}
	let pick = "not picked";
	if (picked.has(record.id)) {
		pick = "picked";
	}
	return `- score ${(record.weighted || 0).toFixed(2)}, confidence ${confidence}, ${pick}: ${cutTitle(record.title)}`;
}

// One topic's lines: its heading with how many candidates Jev scored, then the highest, the lowest and the doubtful in
// between, or each candidate once when there are few.
function topicLines(name: string, scored: PoolRecord[], picked: Set<string>) {
	if (scored.length === 0) {
		return [`#### ${name}: no scored candidate`];
	}
	const lines = [`#### ${name}: ${scored.length} scored`, ""];
	if (scored.length <= 2 * EACH_END) {
		lines.push("All, highest first:");
		for (const record of scored) {
			lines.push(sampleLine(record, picked));
		}
		return lines;
	}
	lines.push("Highest:");
	for (const record of scored.slice(0, EACH_END)) {
		lines.push(sampleLine(record, picked));
	}
	lines.push("Lowest:");
	for (const record of scored.slice(-EACH_END)) {
		lines.push(sampleLine(record, picked));
	}
	// The doubtful ones the highest and lowest don't already show.
	const doubtful = scored
		.slice(EACH_END, -EACH_END)
		.filter(
			(record) =>
				typeof record.confidence === "number" &&
				record.confidence < DOUBTFUL_BELOW,
		);
	if (doubtful.length > 0) {
		lines.push(`Doubtful, confidence below ${DOUBTFUL_BELOW}:`);
		for (const record of doubtful.slice(0, DOUBTFUL_LINES)) {
			lines.push(sampleLine(record, picked));
		}
		if (doubtful.length > DOUBTFUL_LINES) {
			lines.push(`- and ${doubtful.length - DOUBTFUL_LINES} more`);
		}
	}
	return lines;
}

// The samples part of a run's log section, from the pool as the run leaves it, interests.md's text, the ids today's
// digest picked (as the pool names them) and today's date. Today's scoring failed when the pool holds unscored
// candidates and Jev scored none today; then one line says so in place of the samples.
export function samplesPart(
	pool: Pool,
	interests: string,
	picked: Set<string>,
	today: string,
): string {
	const lines = ["### Jev samples", ""];
	const records = Object.values(pool);
	const unscored = records.filter((record) => record.weighted === undefined);
	const scoredToday = records.some((record) => record.scoredOn === today);
	const weights = topicWeights(interests);
	if (records.length === 0) {
		lines.push("The candidate pool is empty, so there are no samples.");
	} else if (unscored.length > 0 && !scoredToday) {
		let candidates = `${unscored.length} unscored candidates`;
		if (unscored.length === 1) {
			candidates = "1 unscored candidate";
		}
		lines.push(
			`Scoring failed: Jev scored none of the ${candidates} today, so there are no samples.`,
		);
	} else if (weights === null) {
		lines.push(
			"interests.md gives no weight to every topic, so there are no samples.",
		);
	} else {
		for (const topic of weights.topics) {
			// Jev's topic keys are "t<number>", the number search.ts records in a candidate's topics. The candidates are those
			// search.ts's topicCandidates offers the scout today.
			const number = Number(topic.key.slice(1));
			const oldest = daysBefore(today, SEARCH_DAYS);
			const scored = records
				.filter(
					(record) =>
						record.weighted !== undefined &&
						record.topics.includes(number) &&
						record.published <= today &&
						(record.published >= oldest || record.listed !== undefined),
				)
				.sort(byRank);
			lines.push(...topicLines(topic.name, scored, picked), "");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

// The ids of the papers in today's lines of a digests text, as the pool names them: an arXiv id without "arxiv:" and
// its version, a "doi:" or "url:" id whole. A line that doesn't load is left out.
export function todaysPicks(digests: string, today: string): Set<string> {
	const picked = new Set<string>();
	for (const line of readLines(digests)) {
		const digest = line.digest;
		if (!isJsonObject(digest) || digest.date !== today) {
			continue;
		}
		if (!Array.isArray(digest.entries)) {
			continue;
		}
		for (const entry of digest.entries) {
			if (!isJsonObject(entry) || typeof entry.id !== "string") {
				continue;
			}
			if (entry.id.startsWith("doi:") || entry.id.startsWith("url:")) {
				picked.add(entry.id);
			} else {
				picked.add(normalizeId(entry.id));
			}
		}
	}
	return picked;
}
