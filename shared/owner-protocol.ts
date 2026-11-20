// What the owner's page sends to the Worker's owner routes and what they answer: one place for the Worker, the page
// and the tests. Types, limits and the depth check.

// The saved state, in the shapes the page kept in localStorage before (read-state, tags and comments features).
// GET /liminal-space/api/owner/state answers this, 200, JSON.
export type OwnerState = {
	read: Record<string, ReadMark>;
	tags: Record<string, Tags>;
	comments: Record<string, SiteThread[]>;
	feedback: Record<string, FeedbackMark>;
	takeaways: Record<string, Takeaway[]>;
};
export type ReadMark = { depth: Depth; date: string };
// The three depths a read mark can have.
export type Depth = "abstract" | "paper" | "read";
const DEPTHS: Depth[] = ["abstract", "paper", "read"];
// The two tags an entry can have.
export type TagName = "toRead" | "learnFirst";
// Only tags that are on appear: {"toRead": true}, {"learnFirst": true} or both. An entry with neither has no key.
export type Tags = { toRead?: true; learnFirst?: true };
// An entry's Dislike, OK or Like: one mark at most, and the day it was pressed in Asia/Jakarta. OK is
// a thumbs-up, acceptable; Like is a heart, strong interest.
export type Feedback = "dislike" | "ok" | "like";
export type FeedbackMark = { mark: Feedback; date: string };
// A takeaway: what the owner keeps from an entry in their own words, and the recall question whose answer
// it is (null when none was given). created and edited are UTC times like "2026-09-27T16:20:00.000Z"; edited is null
// until an edit. source is where it was saved: through the connector from a Claude app or ChatGPT, or on the page.
export type Takeaway = {
	id: string;
	text: string;
	question: string | null;
	created: string;
	edited: string | null;
	source: TakeawaySource;
};
export type TakeawaySource = "claude.ai" | "ChatGPT" | "page";
// A thread as the page sends it: its first comment opens it; the rest are replies, oldest first.
export type Thread = {
	id: string;
	field: "title" | "abstract" | null;
	passage: string | null;
	occurrence: number | null;
	comments: PageComment[];
};
// A thread as the site holds it, its comments with their authors: highlight is true for a highlight
// which may hold no comments.
export type SiteThread = Omit<Thread, "comments"> & {
	highlight: boolean;
	comments: Comment[];
};
// created and edited are UTC times like "2026-09-27T16:20:00.000Z"; edited is null until an edit. author is who wrote
// it; the site holds it, and the page doesn't send it (PageComment).
export type Comment = {
	id: string;
	text: string;
	created: string;
	edited: string | null;
	author: CommentAuthor;
};
// A comment as the page sends it to the comments route: no author, which the site sets.
export type PageComment = Omit<Comment, "author">;

// What the owner made of one entry, as the connector's search and get_digest show it: its read
// mark, tags, like or dislike (each null when it has none), its threads with their comments, oldest first, and its
// takeaways, newest first.
export type EntryNotes = {
	read: ReadMark | null;
	tags: Tags | null;
	feedback: FeedbackMark | null;
	threads: SiteThread[];
	takeaways: Takeaway[];
};

// The changes, each one POST of JSON with the header "X-Liminal: 1" and the site's own Origin. Answer: 200 {} when
// saved, 400 with the reason as plain text for a body the Worker can't use, 403 for a token, header or Origin it
// refuses.
// POST /liminal-space/api/owner/read: set an entry's read mark, or clear it with depth null.
export type ReadChange = {
	id: string;
	depth: Depth | null;
	date: string;
};
// POST /liminal-space/api/owner/tags: one tag of an entry on or off; the other tag is left as the site holds it. An
// entry whose tags are both off has no row.
export type TagsChange = {
	id: string;
	tag: TagName;
	on: boolean;
};
// POST /liminal-space/api/owner/feedback: set an entry's Dislike, OK or Like, replacing the one it had, or clear it
// with mark null.
export type FeedbackChange = {
	id: string;
	mark: Feedback | null;
	date: string;
};
// POST /liminal-space/api/owner/push: save this device's push subscription, as the browser's
// PushSubscription.toJSON() gives it. The Worker answers 204 when saved, 400 for an endpoint off the known push
// services. The page sends it after the owner allowed notifications.
export type PushSubscriptionChange = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};
// GET /liminal-space/api/owner/push: the VAPID public key the page subscribes with, as base64url text, 200.
export type PushKeyAnswer = { publicKey: string };

// POST /liminal-space/api/owner/takeaways: save one takeaway of an entry, or delete one, by its id. A new takeaway is
// stored with "page" as its source. Saving an id the site holds is an edit: it changes the text, question and edited,
// and keeps the entry, created and source the site holds. A delete reaches only that entry's takeaway. The text can't
// be empty or only spaces; an empty question is stored as null.
export type TakeawayChange =
	| { entryId: string; save: PageTakeaway }
	| { entryId: string; delete: string };
export type PageTakeaway = Omit<Takeaway, "source">;
// POST /liminal-space/api/owner/comments: save comments into one thread and delete comments from it, each by its own
// id, so a comment another device saved is never removed by a page that hasn't seen it. A new comment, a reply or an
// edit saves one comment; deleting a reply deletes one; deleting a thread's first comment deletes every comment the
// page knows in it. The thread's place (field, passage, occurrence) is kept from its first save. A thread left with
// no comments is removed, unless it is a highlight. "highlight" true makes the thread a highlight, false makes it an
// ordinary thread again; left out, the thread keeps what it was. A body with "highlight" may save and delete nothing.
// Only a thread on a passage can be a highlight.
export type CommentsChange = {
	entryId: string;
	thread: ThreadPlace;
	save: PageComment[];
	delete: string[];
	highlight?: boolean;
};
export type ThreadPlace = {
	id: string;
	field: "title" | "abstract" | null;
	passage: string | null;
	occurrence: number | null;
};
// Who wrote a comment: the owner on the page, or Claude through the ask route. Only the ask
// route writes "claude"; the comments route writes "owner" and refuses a body whose comment names an author (400).
export type CommentAuthor = "owner" | "claude";

// POST /liminal-space/api/owner/ask: ask Claude about one thread. The Worker reads the thread, its comments and the
// entry from the database; the page sends only where the thread is. The answer streams as text/plain, Claude's
// reply as it is written, and the Worker saves it into the thread as a "claude" comment when it ends. A refusal is
// an AskRefusal's status with its reason as plain text, before any reply text.
export type AskRequest = { entryId: string; threadId: string };
export type AskRefusal = "notSetUp" | "budget" | "failed";

// What the page shows in a thread while Claude answers, and for each refusal.
export const ASK_MESSAGES: Record<AskRefusal | "answering", string> = {
	answering: "Claude is answering…",
	notSetUp: "Claude isn't set up on this site.",
	budget: "Claude's budget for this month is used up.",
	failed: "Claude couldn't answer.",
};

// Whether a comment asks Claude: it holds "@Claude" as a word, in any letter case.
export function mentionsClaude(text: string): boolean {
	return CLAUDE_MENTION.test(text);
}

// "@Claude" with no letter, digit or underscore on either side: "me@claude.com" and "@Claudette" don't count.
export const CLAUDE_MENTION = /(?<![\p{L}\p{N}_])@claude(?![\p{L}\p{N}_])/iu;

// Whether a value is one of DEPTHS.
export function isDepth(value: unknown): value is Depth {
	return DEPTHS.some((depth) => depth === value);
}

// Limits the Worker enforces on every owner body (400 beyond): ids and dates as the page writes them.
export const MAX_ID_LENGTH = 2000;
// The longest text a comment, a takeaway or a recall question may hold.
export const OWNER_TEXT_CHARS = 10000;
export const MAX_OWNER_BODY_BYTES = 1_000_000;
