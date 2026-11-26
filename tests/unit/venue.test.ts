// A paper's venue as the Search sentence names it: one label per conference, year and track.
import { expect, test } from "vitest";
import { venueOf } from "../../shared/venue.ts";

test('"ACL Findings 2026" and "ACL 2026 Findings" read as the same venue, ACL 2026 Findings, in the conference ACL 2026', () => {
	const expected = {
		conference: "ACL 2026",
		track: "Findings",
		label: "ACL 2026 Findings",
	};
	expect(venueOf("ACL Findings 2026")).toEqual(expected);
	expect(venueOf("ACL 2026 Findings")).toEqual(expected);
});

test('a workshop keeps its conference and year, so "NeurIPS 2026 Workshop (BiAlign)" sits under NeurIPS 2026', () => {
	expect(venueOf("NeurIPS 2026 Workshop (BiAlign)")).toEqual({
		conference: "NeurIPS 2026",
		track: "Workshop (BiAlign)",
		label: "NeurIPS 2026 Workshop (BiAlign)",
	});
});

test("a main-track venue reads as its conference and year alone", () => {
	for (const written of [
		"NeurIPS 2026",
		"ACL 2026",
		"ICML 2026",
		"ICLR 2026",
		"COLM 2026",
		"PETS 2026",
		"AIES 2026",
		"FAccT 2026",
	]) {
		expect(venueOf(written)).toEqual({
			conference: written,
			track: "",
			label: written,
		});
	}
});
