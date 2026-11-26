// A venue as the Search sentence names it: the conference and year, and the track within it.
export type Venue = { conference: string; track: string; label: string };

export function venueOf(written: string): Venue {
	throw new Error(`not implemented: ${written}`);
}
