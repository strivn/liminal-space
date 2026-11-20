// @vitest-environment jsdom
// Claude's reply drawn from Markdown: what holds that the reader can't see.
import { describe, expect, test } from "vitest";
import { renderClaudeMarkdown } from "../../site/page/claude-markdown.ts";

// The reply drawn into a page element, as the thread draws it.
function drawn(reply: string): HTMLElement {
	const box = document.createElement("div");
	box.append(renderClaudeMarkdown(reply));
	return box;
}

describe("what a reply may draw", () => {
	test("security: an image in Claude's reply is not drawn and its address is never requested", () => {
		const address = "https://tracker.example/pixel.png";
		const box = drawn(
			`Here: ![chart](${address})\n\n<img src="${address}" onerror="alert(1)">`,
		);
		expect(box.querySelector("img")).toBeNull();
		// No node carries the address as something a browser loads.
		for (const node of box.querySelectorAll("*")) {
			for (const attribute of ["src", "srcset", "data", "poster", "style"]) {
				expect(node.hasAttribute(attribute)).toBe(false);
			}
		}
	});

	test("security: a javascript: link in Claude's reply is drawn as plain text", () => {
		const box = drawn("Open [the paper](javascript:alert(1)) now.");
		expect(box.querySelector("a")).toBeNull();
		expect(box.textContent?.trim()).toBe("Open the paper now.");
	});

	test("security: raw HTML in Claude's reply is drawn as plain text", () => {
		const box = drawn(
			'<script>alert(1)</script>\n\nA <b onclick="x()">bold</b> claim.',
		);
		expect(box.querySelector("script, b")).toBeNull();
		expect(box.textContent).toContain("<script>alert(1)</script>");
		expect(box.textContent).toContain('<b onclick="x()">bold</b>');
	});

	test("security: a heading, a table and a checkbox in Claude's reply are refused with their text kept and no h1, table or input drawn", () => {
		const box = drawn(
			"# Big claim\n\n| a | b |\n| - | - |\n| one | two |\n\n- [ ] a task",
		);
		expect(box.querySelector("h1, table, thead, tr, td, input")).toBeNull();
		expect(box.textContent).toContain("Big claim");
		expect(box.textContent).toContain("one");
		expect(box.textContent).toContain("a task");
	});

	test("security: a link written https:evil.example in Claude's reply is drawn as plain text", () => {
		const box = drawn("Open [the paper](https:evil.example/x) now.");
		expect(box.querySelector("a")).toBeNull();
		expect(box.textContent?.trim()).toBe("Open the paper now.");
	});

	test("security: a link in Claude's reply is drawn with noopener and noreferrer", () => {
		const box = drawn("Read [the paper](https://arxiv.org/abs/2601.00001).");
		const link = box.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://arxiv.org/abs/2601.00001");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
	});
});

describe("math", () => {
	test("underscores and asterisks inside $...$ reach the math typesetter unchanged", () => {
		const box = drawn("Take $a_i * b_j * c_k$ and\n\n$$x_1 * y_2 _z_$$ done.");
		expect(box.querySelector("em, strong")).toBeNull();
		expect(box.textContent).toContain("$a_i * b_j * c_k$");
		expect(box.textContent).toContain("$$x_1 * y_2 _z_$$");
	});
});
