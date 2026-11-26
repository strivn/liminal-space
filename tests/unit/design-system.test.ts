// @vitest-environment jsdom
// Salience's parts as the page builds them: icons drawn from Lucide's markup.
import { describe, expect, test } from "vitest";
import { status, svgIcon } from "../../site/page/dom.ts";
import {
	crownIcon,
	iconSvg,
	menuIcon,
	refreshIcon,
	withIcon,
} from "../../site/page/icons.ts";

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
