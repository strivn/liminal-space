// The published-version script, scripts/scout/proceedings/camera-ready.ts: reading proceedings files, matching papers
// to them, and filling each paper's camera_ready field.
import { test } from "vitest";

test.todo(
	"The proceedings lines in interests.md are read with their conference and address",
);
test.todo(
	"A PMLR BibTeX volume is read into each paper's title, first author and page",
);
test.todo(
	"An ACL Anthology BibTeX volume is read into each paper's title, first author and page",
);
test.todo(
	"A proceedings.neurips.cc, proceedings.iclr.cc or proceedings.colm.cc listing is read into each paper's title, authors and page",
);
test.todo(
	"A PoPETs volume index is read into each paper's title, first author and page",
);
test.todo(
	"AAAI's OAI-PMH records for AIES are read into each paper's title, first author and page",
);
test.todo(
	"A FAccT paper's published version is its DOI from arXiv, else the Crossref record in the FAccT proceedings with the same title and first author",
);
test.todo(
	"A paper matches its published version by its normalised title and its first author's surname",
);
test.todo(
	"A camera-ready title with small edits matches when most of its words and its first two surnames agree",
);
test.todo(
	"Two papers with the same title but different first authors do not match",
);
test.todo(
	"Only papers whose venue names the proceedings' conference and year are matched against them",
);
test.todo(
	"The morning run fills the published version of today's papers that have a venue",
);
test.todo(
	"The weekly check fills every paper with a venue and no published version yet",
);
test.todo("A paper that already has a published version keeps it");
test.todo(
	"Each proceedings file is fetched once per run, however many papers it fills",
);
test.todo(
	"A proceedings site that refuses or times out is named, and its papers wait for the next check",
);
test.todo("A conference with no proceedings line is skipped and named");
test.todo(
	"security: a published version is recorded only as an https page on its proceedings' own site or doi.org",
);
