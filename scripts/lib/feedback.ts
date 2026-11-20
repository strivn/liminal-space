// The owner's Dislike, OK and Like marks on papers from 30 days ago up to today, as sync.ts pull --database writes them to
// feedback.json in the cache folder, for score.ts (Jev's state). OK and Like
// papers share one liked list, each labelled with how strongly it was liked.
// Environment: LIMINAL_CACHE (the cache folder, else .cache/ in the repo; tests point it elsewhere).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../shared/narrow.ts";
import type { Feedback } from "../../shared/owner-protocol.ts";
import { cacheFolder } from "./cli.ts";

// How many days back a mark is still passed on (a mark of 30 days ago is, one of 31 isn't), and how many papers at most
// are passed on as liked (OK and Like together) and as disliked.
export const FEEDBACK_DAYS = 30;
export const FEEDBACK_LIMIT = 10;

// One paper the owner marked: its id, title and abstract, and the day it was marked.
export type FeedbackPaper = {
	id: string;
	title: string;
	abstract: string;
	date: string;
};
// How strongly the owner liked a paper, in the words Jev is told: an OK mark is "acceptable", a Like mark "strong interest".
export type Interest = "acceptable" | "strong interest";
const INTEREST_OF: Record<Exclude<Feedback, "dislike">, Interest> = {
	ok: "acceptable",
	like: "strong interest",
};
// A paper the owner marked OK or Like, and how strongly.
export type LikedPaper = FeedbackPaper & { interest: Interest };
// feedback.json: the papers liked (OK and Like together) and disliked, each list newest first.
export type FeedbackFile = {
	liked: LikedPaper[];
	disliked: FeedbackPaper[];
};
// One mark as the database holds it, with its entry's JSON as stored.
export type FeedbackRow = { mark: Feedback; date: string; entry: unknown };

// Where feedback.json is: in LIMINAL_CACHE, else in the repo's .cache/.
export function feedbackPath(): string {
	return join(cacheFolder(), "feedback.json");
}

// The file's lists from the database's marks: papers only, newest first, at most FEEDBACK_LIMIT liked (OK and Like
// together) and FEEDBACK_LIMIT disliked.
export function feedbackFileOf(rows: FeedbackRow[]): FeedbackFile {
	const file: FeedbackFile = { liked: [], disliked: [] };
	// YYYY-MM-DD dates sort as the days they name.
	const newestFirst = rows.toSorted((a, b) => b.date.localeCompare(a.date));
	for (const row of newestFirst) {
		const entry = row.entry;
		if (!isJsonObject(entry) || entry.type !== "paper") continue;
		if (typeof entry.id !== "string" || typeof entry.title !== "string")
			continue;
		if (typeof entry.abstract !== "string") continue;
		const paper: FeedbackPaper = {
			id: entry.id,
			title: entry.title,
			abstract: entry.abstract,
			date: row.date,
		};
		if (row.mark === "dislike") {
			if (file.disliked.length < FEEDBACK_LIMIT) file.disliked.push(paper);
		} else if (file.liked.length < FEEDBACK_LIMIT) {
			file.liked.push({ ...paper, interest: INTEREST_OF[row.mark] });
		}
	}
	return file;
}

// feedback.json as pull last wrote it; empty lists when there is none or it can't be read.
export function readFeedback(): FeedbackFile {
	const empty: FeedbackFile = { liked: [], disliked: [] };
	let text: string;
	try {
		text = readFileSync(feedbackPath(), "utf8");
	} catch {
		return empty;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return empty;
	}
	if (
		!isJsonObject(parsed) ||
		!Array.isArray(parsed.liked) ||
		!Array.isArray(parsed.disliked)
	) {
		return empty;
	}
	// pull writes the file whole, in this shape.
	return { liked: parsed.liked, disliked: parsed.disliked };
}
