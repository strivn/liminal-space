// Reading HTML tags, shared by describe.ts, figure.ts and proceedings.ts.

// One opening or closing tag as it stands in a page: its name in lower case, whether it closes ("</figure>"), its
// whole text from "<" to ">", and where that text starts and ends in the page.
export type Tag = {
	name: string;
	closing: boolean;
	text: string;
	start: number;
	end: number;
};

// Every tag of these names in a page, in page order, read in one pass: the time grows with the page, never with its
// square. `names` are lower-case tag names; null means every tag. A quoted attribute value may hold ">".
// A tag whose quote or ">" never comes is passed over, and after MAX_UNCLOSED of them the reading stops with the
// tags found so far.
export function tagsNamed(html: string, names: string[] | null): Tag[] {
	let namePattern = "[A-Za-z][A-Za-z0-9:-]*";
	if (names !== null) {
		namePattern = names.join("|");
	}
	// "<" or "</", the name, and then no further name character: "<meta" is not the start of "<metadata".
	const tagStart = new RegExp(`<(/?)(${namePattern})(?![A-Za-z0-9:-])`, "gi");
	const tags: Tag[] = [];
	let unclosed = 0;
	let match = tagStart.exec(html);
	while (match !== null && unclosed < MAX_UNCLOSED) {
		const end = tagEnd(html, tagStart.lastIndex);
		if (end === -1) {
			unclosed += 1;
		} else {
			tags.push({
				name: (match[2] || "").toLowerCase(),
				closing: match[1] === "/",
				text: html.slice(match.index, end),
				start: match.index,
				end: end,
			});
			// The next tag is looked for after this one, so a "<meta" inside a quoted value is not a tag.
			tagStart.lastIndex = end;
		}
		match = tagStart.exec(html);
	}
	return tags;
}

// How many tags that never close are passed over before a page's reading stops.
const MAX_UNCLOSED = 8;

// Where the tag whose attributes start at `from` ends: the index after its ">", a ">" inside a quoted value not
// counting. -1 when the page ends first.
function tagEnd(html: string, from: number): number {
	let quote = "";
	for (let i = from; i < html.length; i++) {
		const char = html[i];
		if (quote !== "") {
			if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ">") {
			return i + 1;
		}
	}
	return -1;
}

// The raw value of one attribute in a tag: double-quoted, single-quoted or unquoted; null when absent.
// The leading \s keeps "name" from matching "data-name".
export function attribute(tag: string, name: string) {
	const match = tag.match(
		new RegExp(
			`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
			"i",
		),
	);
	if (match === null) {
		return null;
	}
	return match[1] || match[2] || match[3] || "";
}
