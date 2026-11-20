// @vitest-environment jsdom
// The takeaway panel against the shared panel scaffold. jsdom has no modal dialog, so showModal and close are stood in.
import { afterEach, expect, test, vi } from "vitest";
import { createSender } from "../../site/page/owner.ts";
import { createTakeawayBoard } from "../../site/page/takeaway-board.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test("the takeaway button opens a panel titled Takeaways, and its close button closes and empties it", () => {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.stubGlobal("visualViewport", null);
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
		this.dispatchEvent(new Event("close"));
	};
	const board = createTakeawayBoard({}, createSender());
	const dialog = document.querySelector("dialog");
	if (dialog === null) throw new Error("the board added no dialog");
	// The dialog is named by its own heading.
	expect(dialog.getAttribute("aria-labelledby")).toBe(
		dialog.querySelector("h2")?.id,
	);
	expect(dialog.querySelector("h2")?.textContent).toBe("Takeaways");

	board
		.button({ id: "arxiv:2601.00001", type: "paper", title: "A paper" })
		.click();
	const body = dialog.querySelector(".comment-panel__body");
	expect(dialog.open).toBe(true);
	expect(body?.children.length).toBeGreaterThan(0);

	dialog.querySelector<HTMLButtonElement>(".comment-panel__close")?.click();
	expect(dialog.open).toBe(false);
	expect(body?.children.length).toBe(0);
});
