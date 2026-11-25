// @vitest-environment jsdom
// The Feed and Selected views: the menu under the date, the topic labels, the marked papers and their notes.
import { test } from "vitest";

test.todo("The public page opens on Selected and the owner's page on Feed");
test.todo("A link to #feed or #selected opens that view on either page");
test.todo(
	"Selected has one label per main OpenAlex topic of the marked papers, with its count, and one is always picked",
);
test.todo(
	"Selected lists only the marked papers of the picked topic, newest mark first",
);
test.todo("A marked paper with no OpenAlex topic yet is under No topic yet");
test.todo("A marked paper's abstract shows its first 5 lines");
test.todo(
	"The owner's Selected has a note box under each paper and no mark button",
);
test.todo("The public Selected shows a note, and no note box");
test.todo("security: a note shows as plain text and never as HTML");
test.todo(
	"A mark or note the Worker refuses is undone and the page says it wasn't saved",
);
test.todo(
	"A marked paper in the public Feed carries Shaped my thinking, linking to Selected",
);
test.todo(
	"The owner's Selected lists a marked paper from a month the page has not loaded",
);
