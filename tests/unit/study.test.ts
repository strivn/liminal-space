import { test } from "vitest";

test.todo("an entry counts as Chinese when its title has a Han character");
test.todo(
	"the model splits each sentence into words, and code cuts the pieces from the stored text, so a study always matches its entry",
);
test.todo(
	"a description's trailing … and a word cut by it become text between words",
);
test.todo(
	"a word the model keeps whole that CC-CEDICT does not list, and that the model does not mark as a name or a term, is split again into the longest CC-CEDICT words",
);
test.todo(
	"a word's pinyin is CC-CEDICT's reading when it lists one, the one pinyin-pro reads in the whole sentence when it lists several, and pinyin-pro's when it lists none",
);
test.todo("every word has one pinyin syllable for each of its Han characters");
test.todo(
	"a word's pinyin is marked confirmed only when CC-CEDICT lists exactly one reading for it",
);
test.todo(
	"a word's meaning is its CC-CEDICT senses for the chosen reading, as written, as many as fit in 80 characters",
);
test.todo(
	"the model's meaning is used only for a word CC-CEDICT does not list, or a term the model marks as meaning something the dictionary lacks, and is then marked as by Claude",
);
test.todo("a word CC-CEDICT does not list is marked as not in the dictionary");
test.todo(
	"only a name the model marks as written for its sound gets no character breakdown",
);
test.todo("an entry the study file already has is skipped");
test.todo("a run studies at most 10 entries");
test.todo(
	"the model's calls for different entries go out together, not one after another",
);
test.todo(
	"a model answer that does not fit its schema is refused, and the run goes on with the next entry",
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
test.todo(
	"security: a meaning from the model longer than 80 characters, or holding a link or a control character, is refused",
);
