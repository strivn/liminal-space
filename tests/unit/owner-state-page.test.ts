// @vitest-environment jsdom
// How the owner's page reads and sends its state (site/page/owner.ts), with a stand-in for the site's answers.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	createSender,
	createStateRefresh,
	loadOwnerState,
	refreshOnReturn,
} from "../../site/page/owner.ts";

// What the stand-in for fetch was asked, in order.
type Asked = { url: string; init: RequestInit | undefined };
let asked: Asked[];

beforeEach(() => {
	asked = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// A fetch that answers every request with this status and JSON body.
function answering(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			asked.push({ url: url, init: init });
			return new Response(JSON.stringify(body), { status: status });
		}),
	);
}

const STATE = {
	read: {},
	tags: {},
	comments: {},
	feedback: {},
	takeaways: {},
};

test("the saved state is read from the site's state route", async () => {
	answering(200, STATE);
	const state = await loadOwnerState();
	expect(state).not.toBeNull();
	expect(asked.map((request) => request.url)).toEqual(["../api/owner/state"]);
});

test("loading the saved state gives null when the site refuses, gives no answer, or sends a body that is not a state", async () => {
	answering(500, STATE);
	expect(await loadOwnerState()).toBeNull();
	answering(200, { read: {}, tags: {} });
	expect(await loadOwnerState()).toBeNull();
	answering(200, ["not", "a", "state"]);
	expect(await loadOwnerState()).toBeNull();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("network down");
		}),
	);
	expect(await loadOwnerState()).toBeNull();
});

test('security: an entry id "__proto__" is an ordinary key in the comments and changes no other object', async () => {
	const body = `{"read":{},"tags":{},"feedback":{},"takeaways":{},"comments":{"__proto__":[{"polluted":true}]}}`;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status: 200 })),
	);
	const state = await loadOwnerState();
	if (typeof state !== "object" || state === null) throw new Error("no state");
	expect(Object.getPrototypeOf(state.comments)).toBeNull();
	expect(Object.hasOwn(state.comments, "__proto__")).toBe(true);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

// A fetch whose answers are held until the test releases them, in the order asked.
function held() {
	const waiting: ((status: number) => void)[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, init?: RequestInit) => {
			asked.push({ url: url, init: init });
			return new Promise<Response>((resolve) => {
				waiting.push((status) =>
					resolve(new Response("{}", { status: status })),
				);
			});
		}),
	);
	return waiting;
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("security: each change is one POST to its route with the header X-Liminal: 1 and its body as JSON", async () => {
	answering(200, {});
	const sender = createSender();
	await sender.send("tags", "arxiv:2601.00001", {
		id: "arxiv:2601.00001",
		tag: "toRead",
		on: true,
	});
	expect(asked).toHaveLength(1);
	expect(asked[0]?.url).toBe("../api/owner/tags");
	expect(asked[0]?.init?.method).toBe("POST");
	expect(asked[0]?.init?.headers).toMatchObject({ "X-Liminal": "1" });
	expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({
		id: "arxiv:2601.00001",
		tag: "toRead",
		on: true,
	});
});

test("changes to one entry are sent in the order made: the second waits for the first's answer", async () => {
	const waiting = held();
	const sender = createSender();
	const first = sender.send("read", "arxiv:2601.00001", { depth: "abstract" });
	const second = sender.send("read", "arxiv:2601.00001", { depth: "paper" });
	await settled();
	expect(asked).toHaveLength(1);
	waiting[0]?.(200);
	await first;
	await settled();
	expect(asked).toHaveLength(2);
	expect(JSON.parse(String(asked[1]?.init?.body))).toEqual({ depth: "paper" });
	waiting[1]?.(200);
	expect(await second).toBe(true);
});

test("changes to different entries don't wait for each other", async () => {
	held();
	const sender = createSender();
	void sender.send("read", "arxiv:2601.00001", {});
	void sender.send("read", "arxiv:2601.00002", {});
	await settled();
	expect(asked).toHaveLength(2);
});

test("a change is pending until the site answers it, and only on the route it was sent to", async () => {
	const waiting = held();
	const sender = createSender();
	const sent = sender.send("read", "arxiv:2601.00001", {});
	expect(sender.pending("read", "arxiv:2601.00001")).toBe(true);
	expect(sender.pending("tags", "arxiv:2601.00001")).toBe(false);
	await settled();
	waiting[0]?.(200);
	await sent;
	expect(sender.pending("read", "arxiv:2601.00001")).toBe(false);
});

test("sending a change the site refuses or doesn't answer gives false and never throws", async () => {
	answering(500, {});
	const sender = createSender();
	expect(await sender.send("read", "arxiv:2601.00001", {})).toBe(false);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("network down");
		}),
	);
	expect(await sender.send("read", "arxiv:2601.00001", {})).toBe(false);
});

test("a change's body is written when it is made, so a later change to the object doesn't alter it", async () => {
	const waiting = held();
	const sender = createSender();
	const change = { depth: "abstract" };
	const sent = sender.send("read", "arxiv:2601.00001", change);
	change.depth = "read";
	await settled();
	waiting[0]?.(200);
	await sent;
	expect(JSON.parse(String(asked[0]?.init?.body))).toEqual({
		depth: "abstract",
	});
});

test("when a change is sent while the saved state is being read, the state is read again before it is shown", async () => {
	const sender = createSender();
	const shown: unknown[] = [];
	let read = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.endsWith("/state")) {
				read += 1;
				// A change is made while the first read is on its way.
				if (read === 1) {
					void sender.send("read", "arxiv:2601.00001", {});
				}
				return new Response(JSON.stringify(STATE), { status: 200 });
			}
			return new Response("{}", { status: 200 });
		}),
	);
	const refresh = createStateRefresh(sender, (fresh) => shown.push(fresh));
	expect(await refresh()).toBe(true);
	expect(read).toBe(2);
	expect(shown).toHaveLength(1);
});

test("when reading the saved state again fails, nothing new is shown and the page keeps what it already shows", async () => {
	answering(500, {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const shown: unknown[] = [];
	const refresh = createStateRefresh(createSender(), (fresh) =>
		shown.push(fresh),
	);
	expect(await refresh()).toBe(false);
	expect(shown).toEqual([]);
});

test("coming back into view reads the saved state once", async () => {
	const refresh = vi.fn(async () => true);
	refreshOnReturn(refresh);
	for (const state of ["hidden", "visible"]) {
		Object.defineProperty(document, "visibilityState", {
			value: state,
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}
	expect(refresh).toHaveBeenCalledTimes(1);
});
