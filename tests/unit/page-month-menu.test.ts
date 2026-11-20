// @vitest-environment jsdom
// The month selector, drawn by the page (site/page/month-menu.ts).
import { afterEach, expect, test, vi } from "vitest";
import { monthMenu } from "../../site/page/month-menu.ts";

const MONTHS = [
	{ value: "2026-10", label: "October 2026" },
	{ value: "2026-09", label: "September 2026" },
	{ value: "2026-08", label: "August 2026" },
];

afterEach(() => {
	document.body.replaceChildren();
});

function menuOn(selected: string | null, onPick = vi.fn()) {
	Element.prototype.scrollIntoView = () => {};
	const menu = monthMenu(MONTHS, selected, onPick);
	document.body.append(menu.root);
	const button = menu.root.querySelector<HTMLButtonElement>("#month-button");
	const list = menu.root.querySelector<HTMLElement>("#month-list");
	if (button === null || list === null) throw new Error("no menu");
	const key = (name: string) =>
		button.dispatchEvent(
			new KeyboardEvent("keydown", { key: name, cancelable: true }),
		);
	return { menu, button, list, key, onPick };
}

const ticked = (list: HTMLElement) =>
	[...list.querySelectorAll('[aria-selected="true"]')].map(
		(option) => option.textContent,
	);

test("the selector shows the selected month, ticked in a closed list", () => {
	const { button, list } = menuOn("2026-10");
	expect(button.textContent).toBe("October 2026");
	expect(list.hidden).toBe(true);
	expect(button.getAttribute("aria-expanded")).toBe("false");
	expect(ticked(list)).toEqual(["October 2026"]);
});

test('with no month selected, the selector reads "All months" and no month is ticked', () => {
	const { button, list } = menuOn(null);
	expect(button.textContent).toBe("All months");
	expect(ticked(list)).toEqual([]);
});

test("a click on the selector opens the list with the selected month highlighted, and a second click closes it", () => {
	const { button, list } = menuOn("2026-09");
	button.click();
	expect(list.hidden).toBe(false);
	expect(button.getAttribute("aria-expanded")).toBe("true");
	expect(button.getAttribute("aria-activedescendant")).toBe(
		"month-option-2026-09",
	);
	button.click();
	expect(list.hidden).toBe(true);
	expect(button.hasAttribute("aria-activedescendant")).toBe(false);
});

test("a click on a month shows it on the selector, closes the list, returns focus to the selector and passes the month to the page", () => {
	const { button, list, onPick } = menuOn("2026-10");
	button.click();
	list.querySelector<HTMLElement>('[data-value="2026-09"]')?.click();
	expect(button.textContent).toBe("September 2026");
	expect(list.hidden).toBe(true);
	expect(document.activeElement).toBe(button);
	expect(onPick).toHaveBeenCalledWith("2026-09");
});

test("the down arrow opens the list, the arrow keys move through the months and wrap around, and Enter picks the highlighted month", () => {
	const { button, list, key, onPick } = menuOn("2026-10");
	key("ArrowDown");
	expect(list.hidden).toBe(false);
	expect(button.getAttribute("aria-activedescendant")).toBe(
		"month-option-2026-10",
	);
	key("ArrowDown");
	expect(button.getAttribute("aria-activedescendant")).toBe(
		"month-option-2026-09",
	);
	key("ArrowUp");
	key("ArrowUp");
	expect(button.getAttribute("aria-activedescendant")).toBe(
		"month-option-2026-08",
	);
	key("ArrowDown");
	key("ArrowDown");
	key("Enter");
	expect(onPick).toHaveBeenCalledWith("2026-09");
	expect(button.textContent).toBe("September 2026");
	expect(list.hidden).toBe(true);
});

test("Enter or Space on a closed selector is left to the browser and picks no month", () => {
	const { button, list, onPick } = menuOn("2026-10");
	for (const name of ["Enter", " "]) {
		const press = new KeyboardEvent("keydown", { key: name, cancelable: true });
		button.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(false);
	}
	expect(list.hidden).toBe(true);
	expect(onPick).not.toHaveBeenCalled();
});

test("Escape closes the open list and the selector still reads its month", () => {
	const { button, list, key, onPick } = menuOn("2026-10");
	button.click();
	key("Escape");
	expect(list.hidden).toBe(true);
	expect(button.textContent).toBe("October 2026");
	expect(onPick).not.toHaveBeenCalled();
});

test("a click elsewhere on the page closes the list, and a click inside the selector does not", () => {
	const { menu, button, list } = menuOn("2026-10");
	const heading = document.createElement("h1");
	document.body.append(heading);
	button.click();
	menu.root
		.querySelector("#month-label")
		?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(list.hidden).toBe(false);
	heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(list.hidden).toBe(true);
});

test('when the page sets a month, the selector shows it ticked, and setting no month shows "All months"', () => {
	const { menu, button, list } = menuOn("2026-10");
	menu.setValue("2026-08");
	expect(button.textContent).toBe("August 2026");
	expect(ticked(list)).toEqual(["August 2026"]);
	menu.setValue(null);
	expect(button.textContent).toBe("All months");
	expect(ticked(list)).toEqual([]);
});
