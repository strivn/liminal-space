// The lab post figure script, scripts/scout/web/post-figure.ts: listing a post's images and writing the scout's pick.
import { test } from "vitest";

test.todo(
	"A lab post's images are listed in page order, numbered, with their alt text and caption",
);
test.todo(
	"Images in the header, navigation, footer and sidebar are not listed",
);
test.todo(
	"Images are read from the article or main element that holds the most paragraph text",
);
test.todo("A Next.js image link is listed as the image it wraps");
test.todo(
	"An srcset whose addresses hold commas gives its largest image whole",
);
test.todo(
	"The picked image is written into the post's line with its alt text, caption and the post as where it is from",
);
test.todo(
	"A pick from outside the post's lab image addresses is refused and the line is left as it was",
);
test.todo("A post that already has a figure keeps it");
test.todo(
	"A post that is not from a listed lab is refused without being fetched",
);
test.todo(
	"security: a post address that resolves to a private network address is never fetched",
);
