// @vitest-environment jsdom
// What the comment and takeaway panels share (site/page/sheet.ts): closing on a press and release outside, and a phone's sheet standing on the keyboard.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPanel, keyboardFit } from "../../site/page/sheet.ts";

// The panel's dialog stood on the page with a box 300 wide: its left edge at 100, its right edge at 400.
function openPanel(asSheet = false) {
	const panel = createPanel({
		titleId: "t",
		title: "Comments",
		onClose: () => {},
	});
	document.body.append(panel.dialog);
	panel.dialog.getBoundingClientRect = () =>
		({ left: 100, right: 400, top: 0, bottom: 800 }) as DOMRect;
	panel.open(asSheet);
	return panel;
}

const press = (x: number) =>
	document.body.dispatchEvent(
		new PointerEvent("pointerdown", { clientX: x, clientY: 10, bubbles: true }),
	);
// A click on `target` that ends at x: the dialog itself for the dimmed page and for its own padding.
const release = (target: Element, x: number) =>
	target.dispatchEvent(
		new MouseEvent("click", { clientX: x, clientY: 10, bubbles: true }),
	);

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
		this.dispatchEvent(new Event("close"));
	};
	vi.stubGlobal("visualViewport", null);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("closing on a press outside", () => {
	test.each([
		["a press and a release on the dimmed page close it", 40, 40, true],
		["a press and a release in its own padding keep it open", 150, 150, false],
		[
			"a press inside that is released outside is a drag, and keeps it open",
			150,
			40,
			false,
		],
		["a press outside that is released inside keeps it open", 40, 150, false],
	])("%s", (_name, pressedAt, releasedAt, closes) => {
		const panel = openPanel();
		press(pressedAt);
		release(panel.dialog, releasedAt);
		expect(panel.dialog.open).toBe(!closes);
	});

	test("a click on something inside the dialog never closes it", () => {
		const panel = openPanel();
		press(40);
		release(panel.body, 40);
		expect(panel.dialog.open).toBe(true);
	});

	test("a click outside without a new press keeps the panel open, even after an earlier press outside", () => {
		const panel = openPanel();
		press(40);
		release(panel.body, 40);
		release(panel.dialog, 40);
		expect(panel.dialog.open).toBe(true);
	});

	test("the close button closes it and empties its body", () => {
		const closed = vi.fn();
		const panel = createPanel({
			titleId: "t",
			title: "Comments",
			onClose: closed,
		});
		document.body.append(panel.dialog);
		panel.open(false);
		panel.body.append(document.createElement("p"));
		panel.closeButton.click();
		expect(panel.dialog.open).toBe(false);
		expect(panel.body.children).toHaveLength(0);
		expect(closed).toHaveBeenCalledTimes(1);
	});
});

// A visual viewport that keeps its listeners, 616 tall as with the keyboard up.
function stubViewport(height: number, offsetTop: number) {
	const listeners = new Map<string, Set<() => void>>();
	const viewport = {
		height,
		offsetTop,
		addEventListener: (type: string, listener: () => void) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)?.add(listener);
		},
		removeEventListener: (type: string, listener: () => void) => {
			listeners.get(type)?.delete(listener);
		},
	};
	vi.stubGlobal("visualViewport", viewport);
	Object.defineProperty(window, "innerHeight", {
		value: 956,
		configurable: true,
	});
	return {
		viewport,
		count: () =>
			(listeners.get("resize")?.size || 0) +
			(listeners.get("scroll")?.size || 0),
		fire: (type: string) => {
			for (const listener of listeners.get(type) || []) listener();
		},
	};
}

describe("a sheet on the keyboard", () => {
	test("an open sheet keeps clear of the keyboard as the visual viewport resizes or scrolls, and stops when it closes", () => {
		const keyboard = stubViewport(956, 0);
		const panel = openPanel(true);
		expect(keyboard.count()).toBe(2);

		keyboard.viewport.height = 616;
		keyboard.fire("resize");
		expect(panel.dialog.style.getPropertyValue("--keyboard-inset")).toBe(
			"340px",
		);
		keyboard.viewport.offsetTop = 120;
		keyboard.fire("scroll");
		expect(panel.dialog.style.getPropertyValue("--keyboard-inset")).toBe(
			"220px",
		);

		panel.closeButton.click();
		expect(keyboard.count()).toBe(0);
		expect(panel.dialog.style.getPropertyValue("--keyboard-inset")).toBe("");
	});

	test("a panel that isn't a sheet does not listen to the visual viewport", () => {
		const keyboard = stubViewport(616, 0);
		openPanel(false);
		expect(keyboard.count()).toBe(0);
	});

	test("a browser with no visual viewport opens and closes the sheet without error", () => {
		vi.stubGlobal("visualViewport", null);
		const sheet = document.createElement("div");
		const fit = keyboardFit(sheet);
		expect(() => {
			fit.start();
			fit.stop();
		}).not.toThrow();
	});
});
