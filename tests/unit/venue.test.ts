// A paper's venue as the Search sentence names it: one label per conference, year and track.
import { test } from "vitest";

test.todo(
	'"ACL Findings 2026" and "ACL 2026 Findings" read as the same venue, ACL 2026 Findings, in the conference ACL 2026',
);
test.todo(
	'a workshop keeps its conference and year, so "NeurIPS 2026 Workshop (BiAlign)" sits under NeurIPS 2026',
);
test.todo("a main-track venue reads as its conference and year alone");
