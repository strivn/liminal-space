// One entry drawn: its text, Figure 1, icon rail and read toggles; and the heatmap.
import { hasText } from "../../shared/entry-checks.ts";
import { isLabFigure } from "../../shared/lab-figures.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import type { Depth } from "../../shared/owner-protocol.ts";
import SOURCE_ICONS from "../icons/index.json" with { type: "json" };
import type { CommentBoard, CommentView } from "./comment-board.ts";
import { siteFile } from "./data.ts";
import {
	dayCrowned,
	heatCaption,
	heatLevel,
	heatmapDays,
	heatTitle,
	LONG_DATE,
	shortDayLabel,
	weekCrowned,
} from "./days.ts";
import { announce, el } from "./dom.ts";
import type { FeedbackBoard } from "./feedback-board.ts";
import {
	crownIcon,
	type RailIcon,
	railButton,
	railToggles,
	showRailIcon,
} from "./icons.ts";
import { readCounts } from "./state.ts";
import type { TagBoard } from "./tag-board.ts";
import type { TakeawayBoard } from "./takeaway-board.ts";
import {
	discussLink,
	metaLine,
	referenceText,
	safeUrl,
	talkLink,
} from "./text.ts";
import type { Entry, ReadState } from "./types.ts";
import { linkAddresses, typeset } from "./typeset.ts";

// The read toggles, the icon rail's second group: Abstract and Paper for a paper. Only papers are tracked, so any other
// type has none and gets null. Their redraw goes into `views`. A press calls onChange with the entry and the depth
// pressed; the read board toggles the mark, saves it and redraws every toggle and the heatmap.
function readToggles(
	entry: Entry,
	state: ReadState,
	onChange: (entry: Entry, depth: Depth) => void,
	views: (() => void)[],
) {
	if (entry.type !== "paper") return null;
	const choices: { depth: Depth; text: string; icon: RailIcon }[] = [
		{ depth: "abstract", text: "Abstract", icon: "abstract" },
		{ depth: "paper", text: "Paper", icon: "paper" },
	];
	const toggles = choices.map((choice) => ({
		icon: choice.icon,
		name: choice.text,
		// A toggle is pressed when the entry's saved depth is its own.
		pressed: () => {
			const saved = state[entry.id];
			return Boolean(saved && saved.depth === choice.depth);
		},
		press: () => onChange(entry, choice.depth),
	}));
	const group = railToggles(toggles, views);
	// Each button carries its depth, which the phone's swipe presses by (phone.ts).
	group.querySelectorAll("button").forEach((button, index) => {
		const choice = choices[index];
		if (choice !== undefined) button.dataset.depth = choice.depth;
	});
	return group;
}

// A link to the page a venue was read on: "the paper's first page" for arXiv, else the site's name without "www.".
// null when the source isn't a web address.
function venueSourceLink(url: unknown) {
	const safe = safeUrl(url);
	if (!safe) return null;
	let host: string;
	try {
		host = new URL(safe).hostname.replace(/^www\./, "");
	} catch {
		return null; // "http://" alone passes safeUrl but isn't an address
	}
	let text = host;
	if (host === "arxiv.org" || host === "export.arxiv.org")
		text = "the paper's first page";
	return el("a", { href: safe }, text);
}

// "Accepted at AIES 2026 · aies-conference.com": an acceptance the scout read outside arXiv's own fields, and where
// it read it. null when the entry has no venue.
function acceptedLine(entry: Entry) {
	if (!hasText(entry.venue)) return null;
	const line = el(
		"p",
		{ class: "entry__venue entry__venue--accepted" },
		`Accepted at ${entry.venue}`,
	);
	const source = venueSourceLink(entry.venue_source);
	if (source) line.append(" · ", source);
	return line;
}

// Where a Figure 1 may load from: arXiv's HTML version, whose image address scripts/scout/arxiv/figure.ts records. Any other
// address, even plain http or another page on arxiv.org, is never requested.
const FIGURE_SITE = "https://arxiv.org/html/";
// How long Copy shows "Copied" after the last click, and how long the status region holds what Copy says.
const COPIED_MS = 2000;

// A width or height in px: a number above 0.
function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// A paper's Figure 1, or a lab post's figure.
function figureNode(entry: Entry) {
	const figure = entry.figure;
	if (!isJsonObject(figure) || typeof figure.src !== "string") return null;
	const isPaper = entry.type === "paper";
	if (isPaper && !figure.src.startsWith(FIGURE_SITE)) return null;
	if (
		!isPaper &&
		(typeof entry.url !== "string" || !isLabFigure(entry.url, figure.src))
	)
		return null;

	// loading comes before src, so the browser knows to wait until the image is near the screen.
	const attributes: Record<string, string> = {
		loading: "lazy",
		decoding: "async",
	};
	if (!isPaper) attributes.referrerpolicy = "no-referrer";
	attributes.src = figure.src;
	attributes.alt = "Figure 1";
	if (!isPaper) attributes.alt = hasText(figure.alt) ? figure.alt : "Figure";
	const image = el("img", attributes);
	// Width and height reserve the image's box before it loads, so nothing below it moves when it arrives.
	if (isSize(figure.width) && isSize(figure.height)) {
		image.setAttribute("width", String(figure.width));
		image.setAttribute("height", String(figure.height));
	}
	// The image itself opens the figure in arXiv's HTML version; there is no separate text link.
	let shown: HTMLElement = image;
	const from = safeUrl(figure.from);
	if (from)
		shown = el(
			"a",
			{
				class: "entry__figure-link",
				href: from,
				title: isPaper ? "Figure 1 in arXiv's HTML version" : "Open the post",
			},
			image,
		);
	const node = el("figure", { class: "entry__figure" }, shown);
	if (hasText(figure.caption)) {
		const caption = el("figcaption", null, figure.caption);
		if (isPaper) typeset(caption);
		linkAddresses(caption);
		node.append(caption);
	}
	// An image arXiv doesn't serve, or that can't load offline, would show as a broken icon over its caption: leave
	// out the whole figure.
	image.addEventListener("error", () => node.remove());
	return node;
}

// The URL of a paper's link labelled "PDF", or null when it has none that can be a link.
function pdfLinkOf(entry: Entry) {
	for (const link of entry.links || []) {
		if (!isJsonObject(link)) continue;
		const url = safeUrl(link.url);
		if (link.label === "PDF" && url) return url;
	}
	return null;
}

// arXiv's small logomark, linking to a paper's abstract page: the red and grey file in both themes. It is arXiv's own
// file, unaltered, as its brand guidelines ask (no recolouring), and its light grey reads on the dark background too.
// It sits in site/ so the page works offline.
// The stored icon of the site `url` is on, or null when none is stored or the URL doesn't parse.
function sourceIcon(url: string) {
	let host: string;
	try {
		host = new URL(url).host;
	} catch {
		return null;
	}
	const icons: Record<string, string> = SOURCE_ICONS;
	const file = icons[host];
	if (!file) return null;
	return el("img", {
		class: "entry__icon",
		src: siteFile(`icons/${file}`),
		alt: "",
	});
}

function arxivLogomark(url: string) {
	const mark = el("img", {
		class: "entry__arxiv-mark",
		src: siteFile("arxiv-logomark-small.svg"),
		alt: "arXiv",
	});
	return el(
		"a",
		{
			class: "entry__arxiv",
			href: url,
			"aria-label": "arXiv abstract page",
			title: "arXiv abstract page",
		},
		mark,
	);
}

// What the owner's page adds to each entry: the icon rail (Comment, Copy, Discuss, Talk about it, Takeaway, the read
// toggles, the tags, Dislike, OK and Like) and its comments. `readState` is the page's read state, which the toggles
// show; onReadChange hands a press and its depth to the read board; `toggleViews` collects each entry's toggle redraw.
export type EntryControls = {
	readState: ReadState;
	onReadChange: (entry: Entry, depth: Depth) => void;
	toggleViews: (() => void)[];
	board: CommentBoard;
	tagBoard: TagBoard;
	feedbackBoard: FeedbackBoard;
	takeawayBoard: TakeawayBoard;
};

// When an entry's math is typeset: as it is drawn, or when its folded day first unfolds (typesetFolded).
export type Typesetting = "now" | "on unfold";

// The typesetting each entry drawn "on unfold" still waits for, by its <article>.
const waitingTypeset = new WeakMap<Element, () => void>();

// Typeset the math, and link the addresses, of every entry in `container` drawn "on unfold" and not done yet. A
// first-draw trace on a phone with a 4x slower CPU found one 284 ms task, 39% of it typesetting every day of the
// month; a folded day's text stays in the page as written, so the browser's find still
// reaches it.
export function typesetFolded(container: Element): void {
	for (const article of container.querySelectorAll("article.entry")) {
		const finish = waitingTypeset.get(article);
		if (finish === undefined) continue;
		waitingTypeset.delete(article);
		finish();
	}
}

// An entry's <article>. With `controls` (the owner's page) it has its icon rail and comments; without (the public
// page) only its text. `typesetting` says when its math is typeset.
export function renderEntry(
	entry: Entry,
	controls: EntryControls | null,
	typesetting: Typesetting = "now",
) {
	const isPaper = entry.type === "paper";
	const url = safeUrl(entry.url);
	// The authors on one line and the published date ("9 October 2026") on the next, each only when the entry has it.
	let byline: HTMLElement | null = null;
	const authors = (entry.authors || []).join(", ");
	if (authors) byline = el("p", { class: "entry__byline" }, authors);
	let published: HTMLElement | null = null;
	if (entry.published)
		published = el(
			"p",
			{ class: "entry__date" },
			LONG_DATE.format(new Date(`${entry.published}T00:00:00Z`)),
		);
	// A paper's PDF link becomes its title link, so it isn't repeated in the links row. A link that isn't an
	// object (null in a hand-edited list) is passed over, like one that isn't http(s).
	let pdfUrl: string | null = null;
	if (isPaper) pdfUrl = pdfLinkOf(entry);
	const links: HTMLElement[] = [];
	for (const link of entry.links || []) {
		if (!isJsonObject(link)) continue;
		const linkUrl = safeUrl(link.url);
		if (!linkUrl) continue;
		if (pdfUrl && link.label === "PDF") continue;
		// A label that isn't text shows as text, as append writes it; a missing one leaves the link empty.
		let label: string | null = null;
		if (link.label !== null && link.label !== undefined)
			label = String(link.label);
		links.push(el("a", { href: linkUrl }, label));
	}

	// Optional parts, each only when the entry has the field.
	let surprise = null;
	if (entry.pick === "surprise")
		surprise = el("p", { class: "entry__kicker" }, "Surprise");
	let journalRef = null;
	if (entry.journal_ref) {
		journalRef = el(
			"p",
			{ class: "entry__venue" },
			`Journal reference: ${entry.journal_ref}`,
		);
		linkAddresses(journalRef);
	}
	let comment = null;
	if (entry.comment) {
		comment = el("p", { class: "entry__venue" }, `Comments: ${entry.comment}`);
		linkAddresses(comment);
	}
	let description = null;
	if (!isPaper && entry.description) {
		const descriptionText = el("p", null, String(entry.description));
		linkAddresses(descriptionText);
		description = el("div", { class: "entry__description" }, descriptionText);
	}

	// A paper's title opens its PDF; the arXiv logomark after it opens the abstract page. Everything else keeps its URL.
	let titleUrl = url;
	if (pdfUrl) titleUrl = pdfUrl;
	let titleContent: string | HTMLElement = entry.title;
	// draggable="false" with style.css's user-select lets a mouse drag select a title's words for a comment.
	if (titleUrl)
		titleContent = el("a", { href: titleUrl, draggable: "false" }, entry.title);
	const title = el("h3", { class: "entry__title" }, titleContent);
	// No space is added before the logomark (CSS spaces it): the title's text, which comments anchor to, stays the same.
	// A paper from a conference's proceedings links its own site's page, which gets no arXiv mark.
	if (pdfUrl && url && url.startsWith("https://arxiv.org/")) {
		title.append(arxivLogomark(url));
	}
	// A news item, report or article from a site whose icon is stored (scripts/scout/newsfeed/icons.ts) shows it before its title.
	// It has no text, so the title's text stays the same.
	const icon = !isPaper && url ? sourceIcon(url) : null;
	if (icon) title.prepend(icon);
	let abstract: HTMLElement | null = null;
	if (entry.abstract)
		abstract = el("p", { class: "entry__abstract" }, String(entry.abstract));
	// Only papers carry TeX; in news a "$" is money. Addresses in the text become links once the math is typeset, so
	// none lands inside a formula. A title that is already a link holds no second one.
	const shownAbstract = abstract;
	function finishText() {
		if (isPaper) {
			typeset(title);
			if (shownAbstract) typeset(shownAbstract);
		}
		if (!titleUrl) linkAddresses(title);
		if (shownAbstract) linkAddresses(shownAbstract);
	}
	if (typesetting === "now") finishText();
	let linksRow: HTMLElement | null = null;
	if (links.length) linksRow = el("p", { class: "entry__links" }, ...links);

	// The text sits in one box left of the icon rail, whose top is level with the title's (style.css).
	const body = el(
		"div",
		{ class: "entry__body" },
		title,
		byline,
		published,
		acceptedLine(entry),
		journalRef,
		comment,
		description,
		abstract,
		figureNode(entry),
		linksRow,
	);
	const meta = el("p", { class: "entry__meta" }, metaLine(entry));
	if (entry.ad_hoc === true)
		meta.append(el("span", { class: "entry__origin" }, "Ad hoc"));
	// The public page: the text alone, across the rail's room too.
	if (controls === null) {
		const plain = el(
			"article",
			{ class: "entry entry--plain", id: entry.id },
			surprise,
			meta,
			body,
		);
		if (typesetting === "on unfold") waitingTypeset.set(plain, finishText);
		return plain;
	}

	const comments = controls.board.entryView(entry, {
		title: title,
		abstract: abstract,
	});
	const article = el(
		"article",
		{ class: "entry", id: entry.id },
		surprise,
		meta,
		body,
		entryRail(entry, controls, comments),
		comments.column,
	);
	controls.board.attach(comments, article);
	if (typesetting === "on unfold") waitingTypeset.set(article, finishText);
	return article;
}

// An entry's icon rail: Comment and its count, Copy; the read toggles; OK, Like and Dislike in the left column; Discuss,
// Talk about it and Takeaway; the tags in the right. A paper's left column has two buttons more (Abstract and Paper),
// which style.css needs to centre the rail on the window.
function entryRail(
	entry: Entry,
	controls: EntryControls,
	comments: CommentView,
) {
	// Copy turns into a check named "Copied" for 2 seconds after the last click, or a cross named "Copy failed" that
	// stays. A screen reader hears either through the page's status region.
	const copy = railButton("copy", "copy", "Copy");
	let copiedTimer = 0;
	copy.addEventListener("click", () => {
		window.clearTimeout(copiedTimer);
		navigator.clipboard.writeText(referenceText(entry)).then(
			() => {
				showRailIcon(copy, "copied", "Copied");
				announce("Copied", "quiet", COPIED_MS);
				window.clearTimeout(copiedTimer);
				copiedTimer = window.setTimeout(() => {
					showRailIcon(copy, "copy", "Copy");
				}, COPIED_MS);
			},
			() => {
				showRailIcon(copy, "copyFailed", "Copy failed");
				announce("Copy failed", "quiet", COPIED_MS);
			},
		);
	});
	// A new tab, so the page stays where it was; noopener keeps claude.ai from reaching back into this page.
	const discuss = el("a", {
		class: "rail-button discuss",
		href: discussLink(entry),
		target: "_blank",
		rel: "noopener noreferrer",
	});
	showRailIcon(discuss, "discuss", "Discuss");
	const talk = el("a", {
		class: "rail-button discuss",
		href: talkLink(entry),
		target: "_blank",
		rel: "noopener noreferrer",
	});
	showRailIcon(talk, "talk", "Talk about it");
	let railClass = "entry__rail";
	if (entry.type === "paper") railClass += " entry__rail--paper";
	// Two columns, left then right, so focus goes down one and then the other; a phone lays the groups out in one row
	// in their own order (style.css).
	return el(
		"div",
		{ class: railClass },
		el(
			"div",
			{ class: "entry__rail-col" },
			el(
				"div",
				{ class: "entry__rail-group" },
				comments.addButton,
				comments.countButton,
				copy,
			),
			readToggles(
				entry,
				controls.readState,
				controls.onReadChange,
				controls.toggleViews,
			),
			controls.feedbackBoard.toggles(entry),
		),
		el(
			"div",
			{ class: "entry__rail-col" },
			el(
				"div",
				{ class: "entry__rail-group" },
				discuss,
				talk,
				controls.takeawayBoard.button(entry),
			),
			controls.tagBoard.toggles(entry),
		),
	);
}

// Escape hides the heatmap's caption, whether a square has keyboard focus or the mouse rests on one while focus is
// elsewhere. Called once: drawHeatmap redraws the squares and the caption inside `heatmap` after every press.
export function hideCaptionOnEscape(heatmap: HTMLElement | null): void {
	if (heatmap === null) throw new Error("index.html has no #heatmap");
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		const caption = heatmap.querySelector<HTMLElement>(".heatmap__caption");
		if (caption !== null) caption.hidden = true;
		for (const square of heatmap.querySelectorAll("[aria-describedby]"))
			square.removeAttribute("aria-describedby");
	});
}

// A strip square; a crowned day shows the crown instead of its number.
export function stripSquare(
	date: string,
	entries: { id: string; type: string }[],
	state: ReadState,
	crowned: boolean,
	onOpenDay: (date: string) => Promise<void>,
): HTMLElement {
	const { square, counts } = daySquare(date, entries, state, onOpenDay);
	if (!crowned) {
		square.textContent = String(Number(date.slice(8)));
		return square;
	}
	// The crown stands where the number was, so the label says what it stands for.
	square.append(crownIcon("phone-bar__crown"));
	square.setAttribute(
		"aria-label",
		`${heatTitle(date, counts)} · a paper read in depth`,
	);
	return square;
}

// One day's square: shaded by the share of its entries read, labelled with the date and the counts. A day with
// entries is a button that opens it; a day without is a plain square.
function daySquare(
	date: string,
	entries: { id: string; type: string }[],
	state: ReadState,
	onOpenDay: (date: string) => Promise<void>,
) {
	const counts = readCounts(entries, state);
	const square = el(counts.items > 0 ? "button" : "span", {
		class: `heatmap__day heatmap__day--${heatLevel(counts.read, counts.total)}`,
		"aria-label": heatTitle(date, counts),
		"data-date": date,
	});
	// A day without a digest is a picture of that day, not a control: a plain span may not carry a name (ARIA).
	if (!(square instanceof HTMLButtonElement))
		square.setAttribute("role", "img");
	if (square instanceof HTMLButtonElement) {
		square.type = "button";
		square.addEventListener("click", () => {
			void onOpenDay(date);
		});
	}
	return { square: square, counts: counts };
}

// Draw the phone bar's strip: the heatmap's squares for the last 7 days in one row, oldest first, ending today. The
// day being read keeps its ring (strip.dataset.current, set by site/page/phone.ts).
export function drawHeatStrip(
	strip: HTMLElement | null,
	days: { date: string; entries: { id: string; type: string }[] }[],
	state: ReadState,
	today: string,
	onOpenDay: (date: string) => Promise<void>,
): void {
	// index.html has it.
	if (strip === null) throw new Error("index.html has no #heat-strip");
	const entriesByDate = new Map(days.map((day) => [day.date, day.entries]));
	// Each square holds its day of the month, or a crown for a day with a paper read in depth.
	const squares = heatmapDays(today)
		.slice(-7)
		.map((date) => {
			const entries = entriesByDate.get(date) || [];
			const square = stripSquare(
				date,
				entries,
				state,
				dayCrowned(entries, state),
				onOpenDay,
			);
			if (date === strip.dataset.current)
				square.setAttribute("aria-current", "true");
			return square;
		});
	strip.replaceChildren(...squares);
}

// Draw the heatmap: one square per day of the last 84, shaded by the share of that digest day's entries read, its
// title saying the date and the counts. The squares fill each week's column from Monday down, so the first square
// starts in its own weekday's row. Only entry ids are read, so a day of a month not loaded counts from the index.
export function drawHeatmap(
	heatmap: HTMLElement | null,
	days: { date: string; entries: { id: string; type: string }[] }[],
	state: ReadState,
	today: string,
	onOpenDay: (date: string) => Promise<void>,
): void {
	// index.html has it on the owner's page; this runs after the rest of the page is drawn.
	if (heatmap === null) throw new Error("index.html has no #heatmap");
	const entriesByDate = new Map(days.map((day) => [day.date, day.entries]));
	const dates = heatmapDays(today);
	const focused = document.activeElement;
	const focusDate =
		focused instanceof HTMLElement && heatmap.contains(focused)
			? focused.dataset.date
			: undefined;
	const tooltip = el("div", {
		id: "heatmap-caption",
		class: "heatmap__caption",
		role: "tooltip",
		hidden: "",
	});
	const squares = dates.map((date, index) => {
		const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
		const firstWeekday =
			(new Date(`${dates[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
		const column = Math.floor((index + firstWeekday) / 7) + 1;
		const drawn = daySquare(
			date,
			entriesByDate.get(date) || [],
			state,
			onOpenDay,
		);
		const square = drawn.square;
		const counts = drawn.counts;
		// A paper read in depth crowns its day's square.
		if (dayCrowned(entriesByDate.get(date) || [], state))
			square.append(crownIcon("heatmap__crown"));
		square.setAttribute(
			"style",
			`grid-column: ${column}; grid-row: ${((weekday + 6) % 7) + 2}`,
		);
		square.addEventListener("click", () => {
			tooltip.hidden = true;
		});
		const show = () => {
			tooltip.textContent = heatCaption(date, counts);
			tooltip.hidden = false;
			square.setAttribute("aria-describedby", tooltip.id);
		};
		const hide = () => {
			tooltip.hidden = true;
			square.removeAttribute("aria-describedby");
		};
		square.addEventListener("mouseenter", show);
		square.addEventListener("focus", show);
		square.addEventListener("mouseleave", hide);
		square.addEventListener("blur", hide);
		return square;
	});
	// Each column's Monday: the first column's may lie left of the heatmap, where its first days are not drawn.
	const mondays = dates
		.filter(
			(date, index) =>
				index === 0 || new Date(`${date}T00:00:00Z`).getUTCDay() === 1,
		)
		.map((date) => {
			const monday = new Date(`${date}T00:00:00Z`);
			monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
			return monday.toISOString().slice(0, 10);
		});
	const weeks = mondays.map((monday, index) =>
		el(
			"span",
			{
				class: "heatmap__week",
				style: `grid-column: ${index + 1}; grid-row: 1`,
			},
			shortDayLabel(monday).slice(4),
		),
	);
	// A crown under each week with a paper read on all 7 of its days, judged on every day the page knows.
	const weekCrowns: HTMLElement[] = [];
	mondays.forEach((monday, index) => {
		if (!weekCrowned(monday, entriesByDate, state)) return;
		const crown = el("span", {
			class: "heatmap__week-crown",
			role: "img",
			"aria-label": `A paper read on all 7 days of the week of ${shortDayLabel(monday).slice(4)}`,
			"data-week": monday,
			style: `grid-column: ${index + 1}; grid-row: 9`,
		});
		crown.append(crownIcon());
		weekCrowns.push(crown);
	});
	const caption = el(
		"div",
		{
			class: "heatmap__feedback",
			style: `grid-column: 1 / span ${weeks.length}`,
		},
		tooltip,
	);
	heatmap.replaceChildren(...weeks, ...squares, ...weekCrowns, caption);
	if (focusDate !== undefined)
		squares
			.find((square) => square.dataset.date === focusDate)
			?.focus({ preventScroll: true });
}
