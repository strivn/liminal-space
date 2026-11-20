// sendOrRollBack: what the page does once the site has answered a change.
import { expect, test, vi } from "vitest";
import {
	type Sender,
	sendOrRollBack,
	UNREACHABLE,
} from "../../site/page/owner.ts";

// A sender whose one change is answered `stored`; the steps record the order they ran in.
function run(
	stored: boolean,
	superseded: boolean,
	failingStep?: "stored" | "rollBack",
) {
	const sender: Sender = {
		send: async () => stored,
		pending: () => false,
		moves: () => 0,
	};
	const calls: string[] = [];
	const step = (name: "stored" | "rollBack") => () => {
		calls.push(name);
		if (failingStep === name) throw new Error(`${name} failed`);
	};
	const notice = vi.fn((text: string) => {
		calls.push(`notice: ${text}`);
	});
	sendOrRollBack(
		sender,
		"read",
		"arxiv:2601.00001",
		{ id: "arxiv:2601.00001" },
		{
			stored: step("stored"),
			superseded: () => superseded,
			rollBack: step("rollBack"),
		},
		notice,
		"A change not drawn:",
	);
	return calls;
}

// The answer arrives on a later turn of the event loop.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a change the site stored is kept, with no roll back and no notice", async () => {
	const calls = run(true, false);
	await settled();
	expect(calls).toEqual(["stored"]);
});

test("a change the site did not store is rolled back and shows the Not saved notice", async () => {
	const calls = run(false, false);
	await settled();
	expect(calls).toEqual(["rollBack", `notice: Not saved: ${UNREACHABLE}`]);
});

test("a change the site did not store, after a later press on the same entry, shows the notice but is not rolled back", async () => {
	const calls = run(false, true);
	await settled();
	expect(calls).toEqual([`notice: Not saved: ${UNREACHABLE}`]);
});

test("an error while drawing a stored change is logged with its label and causes no unhandled rejection", async () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	try {
		run(true, false, "stored");
		await settled();
		expect(logged).toHaveBeenCalledTimes(1);
		expect(logged.mock.calls[0]?.[0]).toBe("A change not drawn:");
		expect(logged.mock.calls[0]?.[1]).toBeInstanceOf(Error);
		expect(unhandled).not.toHaveBeenCalled();
	} finally {
		process.off("unhandledRejection", unhandled);
		logged.mockRestore();
	}
});
