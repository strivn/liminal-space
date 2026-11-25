// Word tooltips on Chinese entries, for a mouse only.

// The pointer the tooltips need.
export const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

// Wrap the words of each studied entry under root and open a word's tooltip on hover. studied holds the ids
// data/index.json marks with study: true; fetchStudy reads an entry's built study file.
export function startStudy(
	_root: HTMLElement,
	_studied: ReadonlySet<string>,
	_fetchStudy: (entryId: string) => Promise<unknown>,
): void {
	throw new Error("not implemented");
}
