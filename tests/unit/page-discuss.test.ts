// What Discuss and Talk about it type into a new chat for each kind of entry (site/page/text.ts).
import { expect, test } from "vitest";
import { discussLink, discussText, talkLink } from "../../site/page/text.ts";

const entry = (type: string) => ({
	id: `url:https://example.com/${type}`,
	type: type,
	title: "A title",
	url: `https://example.com/${type}`,
});

test.each([
	["paper", "paper"],
	["news", "news item"],
	["article", "article"],
	["report", "report"],
])('the Discuss text calls a %s entry a "%s"', (type, name) => {
	expect(discussText(entry(type))).toContain(
		`discuss this ${name}. Read it first in full.`,
	);
});

test('the Discuss text calls an entry of an unknown type an "entry"', () => {
	expect(discussText(entry("podcast"))).toContain(
		"discuss this entry. Read it first in full.",
	);
});

test.todo(
	"the Discuss text asks the chat to look the entry up through the liminal space connector when it's available",
);

test("Talk about it opens a new ChatGPT chat holding the same text Discuss gives, in the same link form", () => {
	const paper = entry("paper");
	expect(talkLink(paper)).toBe(
		`https://chatgpt.com/?q=${encodeURIComponent(discussText(paper))}`,
	);
	expect(discussLink(paper)).toBe(
		`https://claude.ai/new?q=${encodeURIComponent(discussText(paper))}`,
	);
	expect(new URL(talkLink(paper)).searchParams.get("q")).toBe(
		discussText(paper),
	);
});
