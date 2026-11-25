import { test } from "vitest";

test.todo("a study the Worker accepts replaces the entry's earlier study");
test.todo("a study for an entry the database does not hold is refused");
test.todo(
	"a study whose words do not join back into the stored entry's text is refused",
);
test.todo("security: a study push without the sync service token is refused");
test.todo("security: a study push over 200,000 bytes is refused with 413");
