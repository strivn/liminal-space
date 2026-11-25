// The Selected, Feed and Logs views; Logs is the owner's only.
export type View = "feed" | "selected" | "logs";
export const VIEW_NAMES: Record<View, string> = {
	feed: "Feed",
	selected: "Selected",
	logs: "Logs",
};

export const SELECTED_TEXT = {
	mark: "Select",
	noTopic: "No topic yet",
	note: "Note",
	addNote: "Add a note",
};

export function openingView(hash: string, owner: boolean): View {
	if (hash === "#selected") return "selected";
	if (hash === "#logs") return owner ? "logs" : "selected";
	// Any other address names a view or an entry, and an entry is in the Feed.
	if (hash !== "") return "feed";
	if (owner) return "feed";
	return "selected";
}
