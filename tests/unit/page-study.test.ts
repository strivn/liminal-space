// @vitest-environment jsdom
import { test } from "vitest";

test.todo(
	"hovering a word changes nothing in the entry's title or description, so comment marks stay as they were",
);
test.todo("a comment on a studied title still anchors to the words it quotes");
test.todo(
	"an entry's study file is fetched once, on the first hover of that entry",
);
test.todo("numbers and Latin words get no tooltip");
test.todo(
	"a word's pinyin shows at once and its meaning one second after the hover",
);
test.todo("each character's strokes are drawn three times, two seconds apart");
test.todo(
	"with reduced motion the strokes show still until their box is clicked",
);
test.todo(
	"a word not in the dictionary, or with pinyin not confirmed, is marked in its tooltip",
);
test.todo("Escape closes the tooltip");
test.todo("on a touch screen no word tooltip opens");
test.todo("a study file that does not load leaves the entry as it is");
test.todo("the owner's copy reads the study files from the site's own folder");
test.todo(
	"the page credits CC-CEDICT, Make Me a Hanzi and Arphic with links to their licences",
);
test.todo(
	"security: closing a tooltip removes its drawings without Hanzi Writer's destroy, which writes HTML",
);
test.todo(
	"a character's file is fetched once and shared by every word that uses the character",
);
test.todo("a closed tooltip leaves no stroke animation or timer running");
