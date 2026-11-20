// Building blocks of the drawn page: elements, the page's selection, status labels and the status region.

// Build an element; children are strings (as text, never HTML) or nodes.
// The element comes back typed by its tag: el("button") is an HTMLButtonElement.
export function el<Tag extends keyof HTMLElementTagNameMap>(
	tag: Tag,
	attrs?: Record<string, string> | null,
	...children: (Node | string | null | undefined)[]
) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {}))
		node.setAttribute(key, value);
	// Empty children are left out.
	const kept: (Node | string)[] = [];
	for (const child of children) {
		if (child === null || child === undefined || child === "") continue;
		kept.push(child);
	}
	node.append(...kept);
	return node;
}

// The page's selection. A page shown in a window always has one.
export function pageSelection() {
	const selection = document.getSelection();
	if (selection === null) throw new Error("The page has no selection");
	return selection;
}

// The element an event happened on. Clicks and key presses on this page land on elements.
export function targetElement(event: Event) {
	const target = event.target;
	if (!(target instanceof Element))
		throw new Error(
			`A ${event.type} event landed on something that isn't an element`,
		);
	return target;
}

// The SVG namespace, which createElementNS needs for svg elements.
const SVG_NS = "http://www.w3.org/2000/svg";
// One element of an icon's constant markup, `<path d="..."/>`, and one attribute in it.
const SVG_ELEMENT = /<(\w+)([^>]*)\/>/g;
const SVG_ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

// An svg element drawing `paths`, Lucide's own markup from the icon tables, built node by node with createElementNS:
// no HTML string reaches the page, so Trusted Types can be required. Hidden from
// screen readers; its data-icon says which Lucide icon shows. It lives here, not in icons.ts, because `status` draws
// with it and icons.ts imports `el`.
export function svgIcon(name: string, paths: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("data-icon", name);
	for (const shape of paths.matchAll(SVG_ELEMENT)) {
		const node = document.createElementNS(SVG_NS, shape[1] || "path");
		for (const attribute of (shape[2] || "").matchAll(SVG_ATTRIBUTE))
			node.setAttribute(attribute[1] || "", attribute[2] || "");
		svg.append(node);
	}
	return svg;
}

// Status label: icon plus word, never colour alone (Salience). The icons are Lucide 1.64.0's triangle-alert and
// circle-x, Salience's fixed signs for a warning and an error. A label is page text, such as "Couldn't load this
// day"; a message that comes and goes is said through the status region instead (announce).
const ICONS: Record<"warning" | "danger", { name: string; paths: string }> = {
	warning: {
		name: "triangle-alert",
		paths:
			'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	},
	danger: {
		name: "circle-x",
		paths:
			'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
	},
};
export function status(kind: "warning" | "danger", text: string) {
	const icon = ICONS[kind];
	return el(
		"p",
		{ class: `status status--${kind}` },
		svgIcon(icon.name, icon.paths),
		el("span", null, text),
	);
}

// The page's one live region: a screen reader speaks what is written into it, but only into a region that was in the
// page before the text came. It is empty and visually hidden until it holds a message (style.css .notice).
let region: HTMLElement | null = null;
// The text written last, and the timer that empties the region again.
let written = "";
let clearTimer = 0;

// Put the page's one status region, empty, at the end of the body.
export function startStatusRegion(): void {
	region = el("div", { class: "notice", role: "status" });
	document.body.append(region);
}

// Say `text` through the status region for `ms`: as a notice at the foot of the window, or to screen readers only. A
// new message replaces the one showing and starts the time again. VoiceOver skips a message the same as the one
// before, so a repeat gets a no-break space, which it doesn't read.
export function announce(
	text: string,
	look: "notice" | "quiet",
	ms: number,
): void {
	const holder = region;
	if (holder === null) throw new Error("The status region isn't started");
	let message = text;
	if (message === written) message += " ";
	written = message;
	holder.classList.toggle("notice--quiet", look === "quiet");
	if (look === "notice") holder.replaceChildren(status("warning", message));
	else holder.replaceChildren(message);
	window.clearTimeout(clearTimer);
	clearTimer = window.setTimeout(() => {
		holder.replaceChildren();
		written = "";
	}, ms);
}
