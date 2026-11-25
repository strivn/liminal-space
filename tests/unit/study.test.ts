import { test } from "vitest";

test.todo("an entry counts as Chinese when its title has a Han character");
test.todo(
	"the words the model returns must join back into the exact title and description, or the entry gets no study",
);
test.todo("every word has one pinyin syllable for each of its Han characters");
test.todo(
	"a syllable pinyin-pro reads differently is asked about once more, then kept and marked as not confirmed",
);
test.todo("a word CC-CEDICT does not list is marked as not in the dictionary");
test.todo("an entry the study file already has is not sent to the model again");
test.todo("a run sends at most 10 entries to the model");
test.todo(
	"the model's calls for different entries go out together, not one after another",
);
test.todo(
	"an answer that is not a study is refused, and the run goes on with the next entry",
);
test.todo(
	"CC-CEDICT is downloaded at most once a week and read from the cache otherwise",
);
test.todo(
	"a run whose dictionary cannot be loaded studies nothing and says why",
);
test.todo(
	"--since studies every Chinese entry from that date that has no study yet",
);
test.todo(
	"security: the model runs with no tools, so an entry's text cannot make it read, write or fetch anything",
);
test.todo(
	"security: the model's answer is checked against the study shape before it is written to the study file",
);
