// The OpenAlex topics script, scripts/scout/openalex/topics.ts: adding OpenAlex's topics and keywords to papers.
import { test } from "vitest";

test.todo("An arXiv paper is asked for by the DOI arXiv registers for it");
test.todo(
	"An answer that carries the published version's DOI is matched back to the paper by its arXiv address",
);
test.todo("A paper with a DOI of its own is asked for by that DOI");
test.todo("News, articles and reports are never asked for");
test.todo(
	"A matched paper gets OpenAlex's topics, with their field and score, and its keywords",
);
test.todo(
	"A paper whose OpenAlex title does not start like its own gets nothing and is named on stderr",
);
test.todo(
	"A paper OpenAlex has not classified gets no openalex field, so a later run fills it",
);
test.todo("A paper that already has an openalex field is not asked for again");
test.todo(
	"Only papers from the last 30 days are asked for, unless --all is given",
);
test.todo("One request asks for at most 50 papers");
test.todo(
	"OpenAlex failing or not answering in time leaves the digests file as it was and exits 1",
);
test.todo("privacy: a request names no email, name or address of the owner");
test.todo(
	"security: an answer over the size cap, or not JSON, changes no paper",
);
