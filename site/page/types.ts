// The shapes of the page's data: digest entries and days, read marks, tags and comments.
import type {
	CommentAuthor,
	Depth,
	FeedbackMark,
	TagName,
	Takeaway,
} from "../../shared/owner-protocol.ts";

// A digest entry that checkDigests let through: the fields renderEntry relies on are checked, the rest are as the
// file holds them.
export type Entry = {
	id: string;
	type: string;
	title: string;
	published?: string;
	authors?: string[];
	links?: unknown[];
	url?: unknown;
	source?: unknown;
	abstract?: unknown;
	description?: unknown;
	pick?: unknown;
	venue?: unknown;
	venue_source?: unknown;
	journal_ref?: unknown;
	comment?: unknown;
	figure?: unknown;
	ad_hoc?: unknown;
};

// One day of entries: a checked digests line, or every line of one date merged.
export type Day = { date: string; entries: Entry[] };

// An entry or line checkDigests left out, why, and how many entries it stands for in the header's warning.
export type Skipped = { id: string; reason: string; count: number };

// A labelled group of a day's entries in the contents.
export type ContentsGroup = { label: string; entries: Entry[] };

// One entry's saved read mark. The date is kept as storage holds it; nothing reads it.
type ReadMark = { depth: Depth; date: unknown };
// Read marks by entry id.
export type ReadState = Record<string, ReadMark>;
// One day's read tally, for the heatmap: every entry of the day, then its papers (`total`), how many of them are read
// (`read`) and at which depth. `papers` is the number read at depth "paper".
export type ReadCounts = {
	items: number;
	total: number;
	read: number;
	abstracts: number;
	papers: number;
};

// Tags by entry id; a tag that is off is left out.
export type Tags = Record<string, Partial<Record<TagName, true>>>;

// A heatmap square's shade.
export type HeatLevel = "no-digest" | "none" | "some" | "most" | "all";

// Comments by entry id, as storage holds them: each value is checked by usableThreads before it is drawn.
export type AllComments = Record<string, unknown>;
// One saved comment. The site says who wrote it; a comment the page just made has no author yet, and is the owner's.
export type SavedComment = {
	id: string;
	text: string;
	created: string;
	edited: string | null;
	author?: CommentAuthor;
};
// What a thread points to in its entry: one appearance (from 1) of a passage in the title or abstract.
export type PassageAnchor = {
	field: "title" | "abstract";
	passage: string;
	occurrence: number;
};
// A thread on the whole entry. Saved ones may leave the fields out; passage and occurrence aren't checked.
export type WholeAnchor = {
	field?: null | undefined;
	passage?: unknown;
	occurrence?: unknown;
};
// A comment thread usableThreads let through: its comments, on a passage or on the whole entry. A highlight
// has highlight true and may hold no comments.
export type Thread = {
	id: string;
	highlight?: boolean;
	comments: SavedComment[];
} & (PassageAnchor | WholeAnchor);
// A thread as storage holds it, found by findThread: only its comments are known to be a list.
export type StoredThread = Record<string, unknown> & { comments: unknown[] };

// Dislike, OK and Like marks by entry id; an entry with none has no key.
export type FeedbackMarks = Record<string, FeedbackMark>;

// Takeaways by entry id, each list newest first; an entry with none has no key.
export type AllTakeaways = Record<string, Takeaway[]>;

// The owner's state as the page holds it: read marks, tags, comments, likes and dislikes, and takeaways by entry id.
export type OwnerData = {
	read: ReadState;
	tags: Tags;
	comments: AllComments;
	feedback: FeedbackMarks;
	takeaways: AllTakeaways;
};
