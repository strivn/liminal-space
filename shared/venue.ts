// A venue as the Search sentence names it: the conference and year, and the track within it.
export type Venue = { conference: string; track: string; label: string };

const YEAR = /\b20\d\d\b/;
const WORKSHOP = /\bWorkshop\b(?:\s*\(([^)]*)\))?/i;
const FINDINGS = /\bFindings\b/i;

export function venueOf(written: string): Venue {
	const year = YEAR.exec(written)?.[0] ?? "";
	const workshop = WORKSHOP.exec(written);
	const findings = workshop === null ? FINDINGS.exec(written) : null;
	const trackText = workshop?.[0] ?? findings?.[0] ?? "";
	const series = written
		.replace(YEAR, "")
		.replace(trackText, "")
		.replace(/\s+/g, " ")
		.trim();
	const conference = `${series} ${year}`.trim();
	const track = trackName(workshop, findings);
	return {
		conference,
		track,
		label: track === "" ? conference : `${conference} ${track}`,
	};
}

function trackName(
	workshop: RegExpExecArray | null,
	findings: RegExpExecArray | null,
): string {
	if (workshop !== null) {
		const name = workshop[1]?.trim();
		return name ? `Workshop (${name})` : "Workshop";
	}
	return findings === null ? "" : "Findings";
}
