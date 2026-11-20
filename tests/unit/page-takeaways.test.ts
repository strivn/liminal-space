// @vitest-environment jsdom
// The takeaway panel and button on the owner's page, drawn by start() from an in-memory site (site/page/takeaway-board.ts).
// The page shows times in the computer's zone; the reader's is Jakarta's.
process.env.TZ = "Asia/Jakarta";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type FakeSite,
	openPage,
	paperEntry,
	releasePage,
	siteOf,
	texts,
} from "./page-site.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// 23:20 on Sunday 27 September 2026 in Jakarta.
	vi.setSystemTime(new Date("2026-09-27T16:20:00Z"));
});

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

const ID = "arxiv:2609.00001";

type Saved = {
	id: string;
	text: string;
	question: string | null;
	created: string;
	edited: string | null;
	source: "claude.ai" | "ChatGPT" | "page";
};
const takeaway = (
	id: string,
	text: string,
	created: string,
	extra: Partial<Saved> = {},
): Saved => ({
	id: id,
	text: text,
	question: null,
	created: created,
	edited: null,
	source: "claude.ai",
	...extra,
});

async function ownerWith(takeaways: Record<string, Saved[]> = {}, papers = 1) {
	const entries = Array.from({ length: papers }, (_, i) =>
		paperEntry(`2609.0000${i + 1}`, `Paper ${i + 1}`),
	);
	const site = siteOf([{ date: "2026-09-27", entries: entries }]);
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: takeaways,
	};
	await openPage(site, { owner: true });
	return site;
}

const settle = () => new Promise((done) => setTimeout(done, 0));
const button = (id = ID) => {
	const found = document
		.getElementById(id)
		?.querySelector<HTMLButtonElement>("button.takeaway");
	if (!found) throw new Error(`no Takeaway button on ${id}`);
	return found;
};
const panel = () => {
	const found = document.querySelector<HTMLDialogElement>(".takeaway-panel");
	if (found === null) throw new Error("no takeaway panel");
	return found;
};
const cards = () =>
	[...panel().querySelectorAll(".takeaway-card")].map((card) => ({
		text: card.querySelector(".takeaway-card__text")?.textContent,
		question: card.querySelector(".takeaway-card__question")?.textContent,
		meta: card.querySelector(".takeaway-card__meta")?.textContent,
		warning: card.querySelector(".takeaway-card__warning")?.textContent,
	}));
const typed = (label: string, value: string) => {
	const box = panel().querySelector<HTMLTextAreaElement>(
		`textarea[aria-label="${label}"]`,
	);
	if (box === null) throw new Error(`no ${label} box`);
	box.value = value;
	box.dispatchEvent(new Event("input", { bubbles: true }));
};
const save = () => {
	const found = panel().querySelector<HTMLButtonElement>(
		".comment-editor__save",
	);
	if (found === null) throw new Error("no Save");
	return found;
};
const posts = (site: FakeSite) =>
	site.posts
		.filter((one) => one.path === "api/owner/takeaways")
		.map((one) => one.body as Record<string, unknown>);

test("Takeaway opens a panel of the entry's takeaways, newest first", async () => {
	await ownerWith({
		[ID]: [
			takeaway("a", "Monitorability is fragile", "2026-09-20T10:00:00.000Z"),
			takeaway("b", "CoT can be trained away", "2026-09-26T10:00:00.000Z"),
		],
	});
	button().click();
	expect(panel().open).toBe(true);
	expect(cards().map((card) => card.text)).toEqual([
		"CoT can be trained away",
		"Monitorability is fragile",
	]);
});

test("a card shows its question, its time and the chat it came from", async () => {
	await ownerWith({
		[ID]: [
			takeaway("a", "Monitorability is fragile", "2026-09-27T16:20:00.000Z", {
				question: "Why might CoT monitoring stop working?",
			}),
		],
	});
	button().click();
	expect(cards()).toEqual([
		{
			text: "Monitorability is fragile",
			question: "Q: Why might CoT monitoring stop working?",
			meta: "27 Sep, 23:20 · claude.ai",
			warning: undefined,
		},
	]);
});

test("the Takeaway button counts the entry's takeaways, and an entry with none shows no count", async () => {
	await ownerWith(
		{
			[ID]: [
				takeaway("a", "One", "2026-09-20T10:00:00.000Z"),
				takeaway("b", "Two", "2026-09-21T10:00:00.000Z"),
			],
		},
		2,
	);
	expect(button().getAttribute("aria-label")).toBe("Takeaway (2)");
	expect(button().querySelector(".takeaway-count")?.textContent).toBe("2");
	expect(button("arxiv:2609.00002").getAttribute("aria-label")).toBe(
		"Takeaway",
	);
	expect(
		button("arxiv:2609.00002").querySelector(".takeaway-count"),
	).toBeNull();
});

test("Takeaway on an entry without takeaways opens an empty takeaway box in focus, with an empty question box under it", async () => {
	await ownerWith();
	button().click();
	const boxes = [...panel().querySelectorAll("textarea")];
	expect(
		boxes.map((box) => [box.getAttribute("aria-label"), box.value]),
	).toEqual([
		["Takeaway", ""],
		["Question", ""],
	]);
	expect(document.activeElement).toBe(boxes[0]);
});

test('a takeaway added with its question shows a card marked "on the page", raises the count, and is saved without a source', async () => {
	const site = await ownerWith();
	button().click();
	typed("Takeaway", "Monitorability is fragile");
	typed("Question", "Why might CoT monitoring stop working?");
	save().click();
	await settle();
	expect(cards()).toEqual([
		{
			text: "Monitorability is fragile",
			question: "Q: Why might CoT monitoring stop working?",
			meta: "27 Sep, 23:20 · on the page",
			warning: undefined,
		},
	]);
	expect(button().getAttribute("aria-label")).toBe("Takeaway (1)");
	const [sent] = posts(site);
	expect(sent).toEqual({
		entryId: ID,
		save: {
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			text: "Monitorability is fragile",
			question: "Why might CoT monitoring stop working?",
			created: "2026-09-27T16:20:00.000Z",
			edited: null,
		},
	});
});

test("a takeaway can be saved without a question, and its card shows no question line", async () => {
	const site = await ownerWith();
	button().click();
	typed("Takeaway", "Monitorability is fragile");
	save().click();
	await settle();
	expect(cards()[0]?.question).toBeUndefined();
	expect(posts(site)[0]?.save).toMatchObject({ question: null });
});

test("a takeaway of only spaces can't be saved, and Save is disabled until it holds words", async () => {
	const site = await ownerWith();
	button().click();
	typed("Takeaway", "   ");
	typed("Question", "Why?");
	expect(save().disabled).toBe(true);
	panel()
		.querySelector("form")
		?.dispatchEvent(new Event("submit", { cancelable: true }));
	await settle();
	expect(posts(site)).toEqual([]);
	typed("Takeaway", "Words");
	expect(save().disabled).toBe(false);
});

test("editing a takeaway keeps its creation time and marks it edited, and the change is saved under its entry", async () => {
	const site = await ownerWith({
		[ID]: [
			takeaway("k1", "Monitorability is fragile", "2026-09-27T15:00:00.000Z"),
		],
	});
	button().click();
	panel().querySelector<HTMLButtonElement>(".comment-action")?.click();
	typed("Takeaway", "Monitorability is fragile under training");
	save().click();
	await settle();
	expect(cards()[0]).toMatchObject({
		text: "Monitorability is fragile under training",
		meta: "27 Sep, 22:00 · claude.ai · edited",
	});
	expect(posts(site)).toEqual([
		{
			entryId: ID,
			save: {
				id: "k1",
				text: "Monitorability is fragile under training",
				question: null,
				created: "2026-09-27T15:00:00.000Z",
				edited: "2026-09-27T16:20:00.000Z",
			},
		},
	]);
});

test("deleting a takeaway asks first, keeps it on a no, and removes it and its count on a yes", async () => {
	const site = await ownerWith({
		[ID]: [takeaway("k1", "Kept", "2026-09-27T15:00:00.000Z")],
	});
	button().click();
	const remove = () =>
		[...panel().querySelectorAll<HTMLButtonElement>(".comment-action")].find(
			(one) => one.textContent === "Delete",
		);
	const confirm = vi.fn(() => false);
	window.confirm = confirm;
	remove()?.click();
	expect(confirm).toHaveBeenCalledWith("Delete this takeaway?");
	expect(cards()).toHaveLength(1);
	expect(posts(site)).toEqual([]);
	confirm.mockReturnValue(true);
	remove()?.click();
	await settle();
	expect(cards()).toEqual([]);
	expect(button().getAttribute("aria-label")).toBe("Takeaway");
	expect(posts(site)).toEqual([{ entryId: ID, delete: "k1" }]);
});

test("a takeaway the site doesn't save keeps its text and says so under its card", async () => {
	const site = await ownerWith();
	site.statuses["api/owner/takeaways"] = 500;
	button().click();
	typed("Takeaway", "Monitorability is fragile");
	save().click();
	await settle();
	await settle();
	expect(cards()).toEqual([
		expect.objectContaining({
			text: "Monitorability is fragile",
			warning: "Not saved: couldn't reach the site",
		}),
	]);
});

test("a delete the site refuses puts the card back, with Not deleted under it", async () => {
	const site = await ownerWith({
		[ID]: [takeaway("k1", "Kept", "2026-09-27T15:00:00.000Z")],
	});
	site.statuses["api/owner/takeaways"] = 500;
	button().click();
	window.confirm = () => true;
	[...panel().querySelectorAll<HTMLButtonElement>(".comment-action")]
		.find((one) => one.textContent === "Delete")
		?.click();
	await settle();
	await settle();
	expect(cards()).toEqual([
		expect.objectContaining({
			text: "Kept",
			warning: "Not deleted: couldn't reach the site",
		}),
	]);
	expect(button().getAttribute("aria-label")).toBe("Takeaway (1)");
});

test("an edit the site refuses keeps its new words and its Not saved warning when the page comes back into view", async () => {
	const site = await ownerWith({
		[ID]: [
			takeaway("k1", "Monitorability is fragile", "2026-09-27T15:00:00.000Z"),
		],
	});
	site.statuses["api/owner/takeaways"] = 500;
	button().click();
	panel().querySelector<HTMLButtonElement>(".comment-action")?.click();
	typed("Takeaway", "Monitorability is fragile under training");
	save().click();
	await settle();
	await settle();
	document.dispatchEvent(new Event("visibilitychange"));
	await settle();
	await settle();
	expect(cards()).toEqual([
		expect.objectContaining({
			text: "Monitorability is fragile under training",
			warning: "Not saved: couldn't reach the site",
		}),
	]);
});

test("a takeaway saved in a chat shows, with its count, when the page comes back into view", async () => {
	const site = await ownerWith();
	expect(button().getAttribute("aria-label")).toBe("Takeaway");
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {
			[ID]: [takeaway("k9", "From a chat", "2026-09-27T16:00:00.000Z")],
		},
	};
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() =>
		expect(button().getAttribute("aria-label")).toBe("Takeaway (1)"),
	);
});

test("privacy: a visitor sees no takeaway and no Takeaway button", async () => {
	const site = siteOf([
		{ date: "2026-09-27", entries: [paperEntry("2609.00001", "Paper 1")] },
	]);
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {
			[ID]: [
				takeaway("a", "Monitorability is fragile", "2026-09-27T16:00:00.000Z"),
			],
		},
	};
	await openPage(site);
	expect(document.querySelector("button.takeaway")).toBeNull();
	expect(
		document.querySelector(".takeaway-panel .comment-panel__body")?.children,
	).toHaveLength(0);
	expect(texts("body").join(" ")).not.toContain("Monitorability is fragile");
	expect(site.requested.filter((path) => path.startsWith("api/"))).toEqual([]);
});
