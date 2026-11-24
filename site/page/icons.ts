// The page's icons: Lucide's drawings for the heatmap, the phone bar, the icon rail and the buttons that carry a word.
import { el, svgIcon } from "./dom.ts";

// The crown that marks a heatmap day or week: Lucide 1.64.0's crown (ISC licence), with the path data as lucide-static
// ships it.
export function crownIcon(className?: string): SVGSVGElement {
	const crown = svgIcon(
		"crown",
		'<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
	);
	if (className !== undefined) crown.setAttribute("class", className);
	return crown;
}

// The phone bar's Contents icon: Lucide 1.64.0's menu (ISC licence), with the path data as lucide-static ships it.
export function menuIcon(className: string): SVGSVGElement {
	const menu = svgIcon(
		"menu",
		'<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
	);
	menu.setAttribute("class", className);
	return menu;
}

// The phone bar's Refresh icon: Lucide 1.64.0's refresh-cw (ISC licence), with the path data as lucide-static ships it.
export function refreshIcon(): SVGSVGElement {
	return svgIcon(
		"refresh-cw",
		'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
	);
}

// The icons of an entry's icon rail: Lucide 1.64.0 (ISC licence), by Lucide's name and with the path data as
// lucide-static ships it.
export type RailIcon =
	| "copy"
	| "copied"
	| "copyFailed"
	| "discuss"
	| "comment"
	| "highlighter"
	| "abstract"
	| "paper"
	| "read"
	| "unread"
	| "adhoc"
	| "toRead"
	| "learnFirst"
	| "dislike"
	| "ok"
	| "like"
	| "takeaway"
	| "talk";
const RAIL_ICONS: Record<RailIcon, { name: string; paths: string }> = {
	unread: {
		name: "mail",
		paths:
			'<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
	},
	adhoc: {
		name: "square-kanban-plus",
		paths:
			'<path d="M12 7v4"/><path d="M12.354 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v7.354"/><path d="M15 18h6"/><path d="M16 7v4.536"/><path d="M18 21v-6"/><path d="M8 7v7"/>',
	},
	copy: {
		name: "copy",
		paths:
			'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	},
	copied: {
		name: "check",
		paths: '<path d="M20 6 9 17l-5-5"/>',
	},
	copyFailed: {
		name: "x",
		paths: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	},
	discuss: {
		name: "messages-square",
		paths:
			'<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>',
	},
	comment: {
		name: "message-square-plus",
		paths:
			'<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 8v6"/><path d="M9 11h6"/>',
	},
	highlighter: {
		name: "highlighter",
		paths:
			'<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
	},
	abstract: {
		name: "letter-text",
		paths:
			'<path d="M15 5h6"/><path d="M15 12h6"/><path d="M3 19h18"/><path d="m3 12 3.553-7.724a.5.5 0 0 1 .894 0L11 12"/><path d="M3.92 10h6.16"/>',
	},
	paper: {
		name: "newspaper",
		paths:
			'<path d="M15 18h-5"/><path d="M18 14h-8"/><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"/><rect width="8" height="4" x="10" y="6" rx="1"/>',
	},
	read: {
		name: "circle-check",
		paths: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
	},
	toRead: {
		name: "library",
		paths:
			'<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
	},
	ok: {
		name: "thumbs-up",
		paths:
			'<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/>',
	},
	like: {
		name: "heart",
		paths:
			'<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
	},
	dislike: {
		name: "thumbs-down",
		paths:
			'<path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/><path d="M17 14V2"/>',
	},
	talk: {
		name: "audio-lines",
		paths:
			'<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
	},
	takeaway: {
		name: "notebook-pen",
		paths:
			'<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
	},
	learnFirst: {
		name: "lightbulb",
		paths:
			'<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
	},
};

// The svg of `icon`, hidden from screen readers.
export function iconSvg(icon: RailIcon): SVGSVGElement {
	const lucide = RAIL_ICONS[icon];
	return svgIcon(lucide.name, lucide.paths);
}

// Show `icon` in a rail control and give it `name`, which screen readers read and the tooltip shows. The name also
// fills the label that slides out on hover or focus (style.css), hidden from screen readers, which already read
// aria-label. The name goes in through setAttribute and as text, never as HTML.
export function showRailIcon(
	control: HTMLElement,
	icon: RailIcon,
	name: string,
) {
	control.replaceChildren(
		iconSvg(icon),
		el("span", { class: "rail-label", "aria-hidden": "true" }, name),
	);
	control.setAttribute("aria-label", name);
	control.setAttribute("title", name);
}

// A button in the icon rail: its icon, named `name`. `kind` is its own class (copy, toggle, comment-add).
export function railButton(kind: string, icon: RailIcon, name: string) {
	const button = el("button", { type: "button", class: `rail-button ${kind}` });
	showRailIcon(button, icon, name);
	return button;
}

// One toggle in the icon rail: its icon and name, whether it is pressed now, and what a press does.
type RailToggle = {
	icon: RailIcon;
	name: string;
	pressed: () => boolean;
	press: () => void;
};

// A group of toggles in the icon rail, as the read toggles and the tags are. Its redraw, which shows each toggle
// pressed or not, goes into `views` and runs once now.
export function railToggles(toggles: RailToggle[], views: (() => void)[]) {
	const items = toggles.map((toggle) => {
		const button = railButton("toggle", toggle.icon, toggle.name);
		button.addEventListener("click", () => toggle.press());
		return { toggle: toggle, button: button };
	});
	function showPressed() {
		for (const item of items)
			item.button.setAttribute("aria-pressed", String(item.toggle.pressed()));
	}
	views.push(showPressed);
	showPressed();
	return el(
		"div",
		{ class: "entry__rail-group" },
		...items.map((item) => item.button),
	);
}

// The words on the buttons that carry an icon.
export type ActionName =
	| "Collapse all"
	| "Reply"
	| "Edit"
	| "Delete"
	| "Save"
	| "Cancel";

// Lucide 1.64.0's reply, pencil, trash-2, check and x, for a comment's buttons, and chevrons-down-up for the contents.
const ACTION_ICONS: Record<ActionName, { name: string; paths: string }> = {
	"Collapse all": {
		name: "chevrons-down-up",
		paths: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
	},
	Reply: {
		name: "reply",
		paths: '<path d="M20 18v-2a4 4 0 0 0-4-4H4"/><path d="m9 17-5-5 5-5"/>',
	},
	Edit: {
		name: "pencil",
		paths:
			'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	},
	Delete: {
		name: "trash-2",
		paths:
			'<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
	},
	Save: { name: "check", paths: '<path d="M20 6 9 17l-5-5"/>' },
	Cancel: {
		name: "x",
		paths: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	},
};

// An action's icon alone, for a button named by its aria-label.
export function actionIcon(name: ActionName): SVGSVGElement {
	const icon = ACTION_ICONS[name];
	return svgIcon(icon.name, icon.paths);
}

// Fill a button with its icon before its word. The icon is hidden from screen readers, so the word is the name.
export function withIcon(button: HTMLButtonElement, text: ActionName) {
	const icon = ACTION_ICONS[text];
	button.replaceChildren(
		svgIcon(icon.name, icon.paths),
		el("span", null, text),
	);
	return button;
}
