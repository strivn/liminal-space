// The Feed and Selected views.
export type View = "feed" | "selected";
export const VIEW_NAMES: Record<View, string> = {
	feed: "Feed",
	selected: "Selected",
};

export const SELECTED_TEXT = {
	mark: "Shaped my thinking",
	noTopic: "No topic yet",
	note: "Note",
	addNote: "Add a note",
};

export function openingView(hash: string, owner: boolean): View {
	if (hash === "#selected") return "selected";
	// Any other address names a view or an entry, and an entry is in the Feed.
	if (hash !== "") return "feed";
	if (owner) return "feed";
	return "selected";
}
