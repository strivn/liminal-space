// @vitest-environment jsdom
// Keeping the page in step with the site across devices (site/page/owner.ts): reading the state, reading it again when the page returns, and the order of changes.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createSender,
	createStateRefresh,
	loadOwnerState,
	type OwnerRoute,
	refreshOnReturn,
} from "../../site/page/owner.ts";
import type { OwnerData } from "../../site/page/types.ts";

// The five parts of the owner's state as the site answers them, with `comments` as given.
const state = (comments: unknown = {}) => ({
	read: {},
	tags: {},
	comments: comments,
	feedback: {},
	takeaways: {},
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status: status });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("reading the owner's state", () => {
	test("security: an entry id that is __proto__ is an ordinary key of the comments", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					'{"read":{},"tags":{},"feedback":{},"takeaways":{},"comments":{"__proto__":[{"id":"t1"}]}}',
				),
		);
		const loaded = await loadOwnerState();
		expect(Object.getPrototypeOf(loaded?.comments)).toBeNull();
		expect(Object.keys(loaded?.comments || {})).toEqual(["__proto__"]);
		expect(({} as Record<string, unknown>).id).toBeUndefined();
	});

	test.each([
		["no answer", () => Promise.reject(new Error("offline"))],
		["a refusal", async () => json({}, 403)],
		[
			"Access's sign-in page",
			async () => new Response("<html>sign in</html>", { status: 200 }),
		],
		["an answer that isn't a state", async () => json({ read: {} })],
		["a state whose comments are a list", async () => json(state([]))],
	])("the page treats %s as no state", async (_name, answer) => {
		vi.stubGlobal("fetch", answer);
		expect(await loadOwnerState()).toBeNull();
	});
});

describe("reading the state again", () => {
	// A refresh over a state the site answers once per call, from `answers`; `show` records what the page shows.
	function refresh(answers: (() => Response)[], sender = createSender()) {
		const shown: OwnerData[] = [];
		const asked = vi.fn(async () =>
			(answers.shift() || (() => json({}, 500)))(),
		);
		vi.stubGlobal("fetch", asked);
		return {
			shown,
			asked,
			run: createStateRefresh(sender, (fresh) => shown.push(fresh)),
		};
	}

	test("a state the site answers is shown, and the refresh reports that it was", async () => {
		const page = refresh([() => json(state({ "arxiv:1": [] }))]);
		expect(await page.run()).toBe(true);
		expect(page.shown).toHaveLength(1);
	});

	test("a state that can't be read shows nothing, so the page keeps what it shows", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const page = refresh([() => json({}, 500)]);
		expect(await page.run()).toBe(false);
		expect(page.shown).toHaveLength(0);
	});

	test("a change saved while the state is being read starts a second read, and only the second read is shown", async () => {
		const sender = createSender();
		let release: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const shown: OwnerData[] = [];
		let reads = 0;
		vi.stubGlobal("fetch", async (url: string) => {
			if (String(url).endsWith("state")) {
				reads += 1;
				if (reads === 1) await slow;
				return json(state({ [`read-${reads}`]: [] }));
			}
			return new Response(null, { status: 200 });
		});
		const run = createStateRefresh(sender, (fresh) => shown.push(fresh));
		const done = run();
		// A change goes out and is answered while the first read is still open.
		await sender.send("comments", "arxiv:1", { entryId: "arxiv:1" });
		release();
		expect(await done).toBe(true);
		expect(reads).toBe(2);
		expect(shown.map((one) => Object.keys(one.comments))).toEqual([["read-2"]]);
	});
});

describe("coming back into view", () => {
	const visibility = (state: "visible" | "hidden") => {
		Object.defineProperty(document, "visibilityState", {
			value: state,
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	};

	test("the state is read again when the page returns, and not when it leaves", () => {
		const again = vi.fn(async () => true);
		refreshOnReturn(again);
		visibility("hidden");
		expect(again).not.toHaveBeenCalled();
		visibility("visible");
		expect(again).toHaveBeenCalledTimes(1);
	});

	test("a read that fails on return is logged and does not break the page", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		refreshOnReturn(async () => {
			throw new Error("boom");
		});
		visibility("visible");
		await vi.waitFor(() => expect(logged).toHaveBeenCalled());
	});
});

describe("the order of changes", () => {
	test("changes to one entry reach the site in the order they were made, each after the one before is answered", async () => {
		const answered: string[] = [];
		let open = 0;
		let overlapped = false;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			open += 1;
			if (open > 1) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 5));
			answered.push(String(init.body));
			open -= 1;
			return new Response(null, { status: 200 });
		});
		const sender = createSender();
		await Promise.all([
			sender.send("comments", "arxiv:1", { n: 1 }),
			sender.send("comments", "arxiv:1", { n: 2 }),
			sender.send("comments", "arxiv:1", { n: 3 }),
		]);
		expect(answered).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
		expect(overlapped).toBe(false);
	});

	test("a change is pending for its route and entry until the site answers, and an answer other than 200 reports it unsaved", async () => {
		let answer: ((status: number) => void) | null = null;
		vi.stubGlobal(
			"fetch",
			() =>
				new Promise<Response>((resolve) => {
					answer = (status) => resolve(new Response(null, { status: status }));
				}),
		);
		const sender = createSender();
		const pending = (route: OwnerRoute, id: string) =>
			sender.pending(route, id);
		const sent = sender.send("comments", "arxiv:1", { n: 1 });
		expect(pending("comments", "arxiv:1")).toBe(true);
		expect(pending("comments", "arxiv:2")).toBe(false);
		expect(pending("tags", "arxiv:1")).toBe(false);
		await vi.waitFor(() => expect(answer).not.toBeNull());
		(answer as unknown as (status: number) => void)(500);
		expect(await sent).toBe(false);
		expect(pending("comments", "arxiv:1")).toBe(false);
	});

	test("a change the site never answers is not saved, and the next change still goes", async () => {
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			if (bodies.length === 1) throw new Error("offline");
			return new Response(null, { status: 200 });
		});
		const sender = createSender();
		const first = sender.send("comments", "arxiv:1", { n: 1 });
		const second = sender.send("comments", "arxiv:1", { n: 2 });
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect(bodies).toEqual(['{"n":1}', '{"n":2}']);
	});

	test("a change's body is written when it is made, so a later edit of the object does not change it", async () => {
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return new Response(null, { status: 200 });
		});
		const sender = createSender();
		const change = { text: "before" };
		const sent = sender.send("comments", "arxiv:1", change);
		change.text = "after";
		await sent;
		expect(bodies).toEqual(['{"text":"before"}']);
	});
});
