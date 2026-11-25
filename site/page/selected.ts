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
	throw new Error(`not implemented: ${hash} ${owner}`);
}
