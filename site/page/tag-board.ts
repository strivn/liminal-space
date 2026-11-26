// The tag toggles, and the tags the Search sentence reads.
import type { TagName, TagsChange } from "../../shared/owner-protocol.ts";
import { railToggles } from "./icons.ts";
import { type Sender, sendOrRollBack } from "./owner.ts";
import {
	clearTag,
	copyTags,
	entryTagsOf,
	matchesTags,
	setTag,
	TAG_LABELS,
	TAG_NAMES,
	takeSiteState,
	toggleTag,
} from "./state.ts";
import type { Entry, Tags } from "./types.ts";

// What createTagBoard hands the rest of the page.
export type TagBoard = {
	toggles: (entry: Entry) => HTMLElement;
	clear: (id: string, name: TagName) => void;
	// The labels of the tags an entry carries, as the Search sentence names them.
	labelsOf: (id: string) => string[];
	replace: (fresh: Tags) => void;
};

// The next-action tags on every entry. `saved` is the site's tags; each press goes to the site through `sender`, and
// one the site refuses is undone and `notice` says so. `onChange` runs after the page's tags changed, for what is
// drawn from them. toggles(entry) while the entries are drawn.
export function createTagBoard(
	saved: Tags,
	sender: Sender,
	notice: (text: string) => void,
	onChange: () => void,
): TagBoard {
	// The page's tags, changed at once by a press, and the tags the site is known to hold, for undoing a refused one.
	// Both are replaced when the site's state is read again. The functions below read whichever is current, like a
	// `nonlocal` in Python.
	let tags = copyTags(saved);
	let siteTags = copyTags(saved);
	const views: (() => void)[] = []; // each entry's toggle redraw
	let presses = 0; // tag presses sent since the page opened
	const lastPress = new Map<string, number>(); // "<tag> <entry id>" -> the number of its last press

	// Every tag toggle shows the tags as they are now.
	function redraw() {
		for (const showPressed of views) showPressed();
		onChange();
	}

	// Send one tag of an entry as it now is; the site leaves the entry's other tag as it holds it. When the site doesn't
	// save it, and this was the last press of that tag on that entry, the tag goes back to what the site holds, and
	// the page says why.
	function send(id: string, name: TagName) {
		const change: TagsChange = {
			id: id,
			tag: name,
			on: matchesTags(tags, id, [name]),
		};
		presses += 1;
		const press = presses;
		const pressKey = `${name} ${id}`;
		lastPress.set(pressKey, press);
		sendOrRollBack(
			sender,
			"tags",
			id,
			change,
			{
				// The site now holds what this press sent.
				stored: () => setTag(siteTags, id, name, change.on),
				superseded: () => lastPress.get(pressKey) !== press,
				rollBack: () => {
					setTag(tags, id, name, matchesTags(siteTags, id, [name]));
					redraw();
				},
			},
			notice,
			"A tag change not drawn:",
		);
	}

	// Take the site's tags as the page's own; an entry with a press still on its way keeps what the page shows.
	function replace(fresh: Tags) {
		tags = takeSiteState(
			fresh,
			tags,
			(id) => sender.pending("tags", id),
			entryTagsOf,
		);
		siteTags = copyTags(fresh);
		redraw();
	}

	// To read and Learn first, the icon rail's last group, after the read toggles. A press shows at once, goes to the
	// site, and redraws.
	function toggles(entry: Entry) {
		const tagToggles = TAG_NAMES.map((name) => ({
			icon: name,
			name: TAG_LABELS[name],
			// A toggle is pressed when the entry carries its tag.
			pressed: () => matchesTags(tags, entry.id, [name]),
			press: () => {
				toggleTag(tags, entry.id, name);
				send(entry.id, name);
				redraw();
			},
		}));
		return railToggles(tagToggles, views);
	}

	// Turn one tag off an entry, sent at once. Nothing is sent when it was already off.
	function clear(id: string, name: TagName) {
		if (!matchesTags(tags, id, [name])) return;
		clearTag(tags, id, name);
		send(id, name);
		redraw();
	}

	function labelsOf(id: string) {
		return TAG_NAMES.filter((name) => matchesTags(tags, id, [name])).map(
			(name) => TAG_LABELS[name],
		);
	}

	return {
		toggles: toggles,
		clear: clear,
		labelsOf: labelsOf,
		replace: replace,
	};
}
