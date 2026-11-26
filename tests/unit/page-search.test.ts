// @vitest-environment jsdom
// The Search sentence: its blanks, what each choice shows in the Feed, and the choice panels.
import { test } from "vitest";

test.todo(
	"the sentence reads Show me [everything] about [any subject] from [any venue], [this month] on the public page, and adds [read or not] on the owner's",
);
test.todo(
	"a topic shows only papers whose main OpenAlex topic it is, and a keyword shows only papers that carry it",
);
test.todo(
	"two picked subjects show entries about either, or only entries with both when the reader picks all",
);
test.todo(
	"the kind blank shows everything, papers only, or news and articles only",
);
test.todo(
	"a conference shows every one of its tracks, and a track shows only that track",
);
test.todo(
	"the time blank shows today, the last week, one month or any time, and loads the months its choice needs",
);
test.todo(
	"the read blank shows unread, abstract read or paper read papers, those tagged To read or Learn first, and those added ad hoc",
);
test.todo(
	"every choice shows how many entries it would give with the other blanks as they are, and a choice that gives none cannot be picked",
);
test.todo(
	"the current month is drawn as a choice already made, and Reset shows only after a blank moved from where it started",
);
test.todo(
	"Reset puts every blank back and shows the entries of the current month",
);
test.todo(
	"typing in the subject box lists the topics and keywords that contain the typed letters, and changes nothing in the Feed",
);
test.todo(
	"a topic or keyword under a paper adds itself to the subject and keeps the other blanks and the reading place",
);
test.todo(
	"a paper OpenAlex has not classified yet reads Topics (OpenAlex): none yet, and the subject no topic yet finds it",
);
test.todo(
	"on a wide window the choices open beside the sidebar, so the sentence and its count stay in view",
);
test.todo(
	"on a phone the choices open in a sheet that holds the count, and keeps focus inside it until Done or Escape",
);
test.todo(
	"accessibility: each blank is named for what it filters, single-choice panels are radio groups, and the count is spoken once the reader stops changing it",
);
test.todo(
	"security: topic, keyword and venue names from the search file are drawn as text, never as HTML",
);
