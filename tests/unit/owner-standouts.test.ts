// The owner's standouts: marking a paper that shaped their thinking, and its public note, through the owner API.
import { test } from "vitest";

test.todo("A mark is saved with its day and read back in the owner's state");
test.todo("Unmarking a paper takes it out of the owner's state");
test.todo("A note on a marked paper is saved and read back");
test.todo("Unmarking a paper keeps its note for when it is marked again");
test.todo("A note on a paper that is not marked is refused");
test.todo("A note longer than the owner's text limit is refused");
test.todo("A mark on an id that is not a stored entry is refused");
test.todo(
	"security: a standout change without the owner's sign-in, email, the site's Origin or X-Liminal is refused",
);
