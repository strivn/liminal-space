// @vitest-environment jsdom
// Salience's parts as the page builds them: icons drawn from Lucide's markup, and the month selector, a listbox a screen reader can use.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { status, svgIcon } from "../../site/page/dom.ts";
import {
	crownIcon,
	iconSvg,
	menuIcon,
	refreshIcon,
	withIcon,
} from "../../site/page/icons.ts";
import { monthMenu } from "../../site/page/month-menu.ts";

const SVG = "http://www.w3.org/2000/svg";

describe("icons", () => {
	test("an icon built from Lucide markup is an SVG with every attribute kept, hidden from screen readers", () => {
		const icon = svgIcon(
			"copy",
			'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4"/>',
		);
		expect(icon.namespaceURI).toBe(SVG);
		expect(icon.dataset.icon).toBe("copy");
		expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(icon.getAttribute("aria-hidden")).toBe("true");
		const [rect, path] = Array.from(icon.children);
		expect(rect?.namespaceURI).toBe(SVG);
		expect(rect?.localName).toBe("rect");
		expect(
			Object.fromEntries(
				Array.from(rect?.attributes || [], (a) => [a.name, a.value]),
			),
		).toEqual({ width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" });
		expect(path?.getAttribute("d")).toBe("M4 16c-1.1 0-2-.9-2-2V4");
	});

	test("a button with an icon shows the icon before its word, and giving it a new word replaces both", () => {
		const button = withIcon(document.createElement("button"), "Save");
		expect(button.firstElementChild?.tagName).toBe("svg");
		expect(button.lastElementChild?.textContent).toBe("Save");
		expect(button.textContent).toBe("Save");
		// A second call replaces what the first drew.
		withIcon(button, "Cancel");
		expect(button.children).toHaveLength(2);
		expect(button.textContent).toBe("Cancel");
	});

	test("the crown and the menu icon take the class they are given, and the crown has none without one", () => {
		expect(crownIcon("phone-bar__crown").getAttribute("class")).toBe(
			"phone-bar__crown",
		);
		expect(crownIcon().hasAttribute("class")).toBe(false);
		expect(menuIcon("contents__icon").getAttribute("class")).toBe(
			"contents__icon",
		);
		expect(refreshIcon().children.length).toBeGreaterThan(0);
		expect(iconSvg("copy").children.length).toBeGreaterThan(0);
	});

	test("an error shows the circle-x sign and a warning the triangle-alert sign, with the words beside it", () => {
		const error = status("danger", "Couldn't load");
		expect(error.querySelector("svg")?.dataset.icon).toBe("circle-x");
		expect(error.textContent).toBe("Couldn't load");
		expect(
			status("warning", "Careful").querySelector("svg")?.dataset.icon,
		).toBe("triangle-alert");
	});
});

describe("the month selector", () => {
	const MONTHS = [
		{ value: "2026-10", label: "October 2026" },
		{ value: "2026-09", label: "September 2026" },
	];
	let picked: string[] = [];
	function selector(selected: string | null = "2026-10") {
		picked = [];
		const menu = monthMenu(MONTHS, selected, (value) => picked.push(value));
		document.body.append(menu.root);
		const button = menu.root.querySelector("button") as HTMLButtonElement;
		const list = menu.root.querySelector("ul") as HTMLElement;
		const options = Array.from(list.querySelectorAll<HTMLElement>("li"));
		return { menu, button, list, options };
	}
	const key = (button: HTMLElement, name: string) => {
		const event = new KeyboardEvent("keydown", {
			key: name,
			bubbles: true,
			cancelable: true,
		});
		button.dispatchEvent(event);
		return event;
	};
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});
	afterEach(() => {
		document.body.replaceChildren();
	});

	test("it is a combobox button named by its label and month, with a listbox of one option per month", () => {
		const { button, list, options } = selector();
		expect(button.getAttribute("role")).toBe("combobox");
		expect(button.getAttribute("aria-haspopup")).toBe("listbox");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		// Its accessible name is the hidden "Month" label and its own text.
		const name = button
			.getAttribute("aria-labelledby")
			?.split(" ")
			.map((id) => document.getElementById(id)?.textContent)
			.join(" ");
		expect(name).toBe("Month October 2026");
		expect(list.getAttribute("role")).toBe("listbox");
		expect(list.hidden).toBe(true);
		expect(options.map((option) => option.getAttribute("role"))).toEqual([
			"option",
			"option",
		]);
	});

	test("opening it sets aria-expanded, and only the chosen month's option is selected", () => {
		const { button, list, options } = selector();
		button.click();
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(list.hidden).toBe(false);
		expect(
			options.map((option) => option.getAttribute("aria-selected")),
		).toEqual(["true", "false"]);
		expect(button.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
	});

	test("All months shows its name and selects no option", () => {
		const { button, options } = selector(null);
		expect(button.textContent).toBe("All months");
		expect(
			options.map((option) => option.getAttribute("aria-selected")),
		).toEqual(["false", "false"]);
	});

	test("the arrow keys open the list and move round it, and Enter picks the marked month and closes the list", () => {
		const { button, list, options } = selector();
		expect(key(button, "ArrowDown").defaultPrevented).toBe(true);
		expect(list.hidden).toBe(false);
		key(button, "ArrowDown");
		expect(button.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
		// The marked option wraps from the last to the first, and from the first to the last.
		key(button, "ArrowDown");
		expect(button.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
		key(button, "ArrowUp");
		expect(button.getAttribute("aria-activedescendant")).toBe(options[1]?.id);

		key(button, "Enter");
		expect(picked).toEqual(["2026-09"]);
		expect(list.hidden).toBe(true);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.hasAttribute("aria-activedescendant")).toBe(false);
		expect(button.textContent).toBe("September 2026");
		expect(document.activeElement).toBe(button);
	});

	test("Escape closes it without picking, and a click outside closes it too", () => {
		const { button, list } = selector();
		button.click();
		key(button, "Escape");
		expect(list.hidden).toBe(true);
		expect(picked).toEqual([]);
		button.click();
		document.body.click();
		expect(list.hidden).toBe(true);
	});

	test("Enter on a closed selector is left to the browser, and a click on an option picks it", () => {
		const { button, options } = selector();
		expect(key(button, "Enter").defaultPrevented).toBe(false);
		button.click();
		options[1]?.click();
		expect(picked).toEqual(["2026-09"]);
	});

	test("showing a month chosen elsewhere ticks its option and changes the button's text", () => {
		const { menu, button, options } = selector();
		menu.setValue("2026-09");
		expect(button.textContent).toBe("September 2026");
		expect(
			options.map((option) => option.getAttribute("aria-selected")),
		).toEqual(["false", "true"]);
		expect(picked).toEqual([]);
	});
});
