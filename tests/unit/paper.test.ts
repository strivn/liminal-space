import { test } from "vitest";

test.todo(
	"a paper whose page holds its title and first author's surname, and whose DOI resolves to that page, is appended",
);
test.todo(
	"a page that shows the title only in its citation_title tag, and the author only in citation_author, passes",
);
test.todo("a page without the title is refused, naming the title check");
test.todo(
	"a page without the first author's surname is refused, naming the author check",
);
test.todo(
	"a DOI that resolves to another page is refused, naming both addresses",
);
test.todo("a URL on a private or local address is refused before any request");
test.todo("a page that answers 403 is refused, naming the status");
test.todo("a claim with an arXiv id is refused and sent to arxiv.ts");
test.todo(
	"the appended line has a doi: id when a DOI is given, else a url: id, and passes the digests check",
);
test.todo("a paper already in the digests is not appended again");
test.todo(
	"the claim's text reaches no shell: a title with quotes and $() is appended as written",
);
