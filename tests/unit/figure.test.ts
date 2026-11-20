// Unit tests for the pure export of scripts/scout/arxiv/figure.ts, figureFromHtml(html, baseUrl). It returns { imageUrl, caption, width, height } for a paper's Figure 1, or
// { reason } when the paper has none to record. Pages are small and written the way LaTeXML writes them.

import assert from "node:assert/strict";
import { test } from "vitest";
import type * as Figure from "../../scripts/scout/arxiv/figure.ts";

const SCRIPT = new URL("../../scripts/scout/arxiv/figure.ts", import.meta.url);

// A page's final URL as arXiv serves it at /html/<id>; LaTeXML's srcs inside it are "<id>v1/<file>" (measured).
const BASE = "https://arxiv.org/html/2609.35544";

// The width and height LaTeXML writes on the usual <img>: the size the page shows it at.
const SHOWN_SIZE = 'width="548" height="275"';

// figureFromHtml's answer read field by field, as the tests read it: a field the answer lacks reads as undefined.
type FigureFields = {
	imageUrl?: string;
	caption?: string;
	width?: number;
	height?: number;
	reason?: string;
};

// ---- Pages ----

// A paper's HTML page holding `body` after its title.
function page(body: string) {
	return [
		'<!DOCTYPE html><html lang="en">',
		'<head><meta http-equiv="content-type" content="text/html; charset=UTF-8"><title>Fixture paper</title></head>',
		'<body><div class="ltx_page_main"><article class="ltx_document">',
		'<h1 class="ltx_title ltx_title_document">Fixture paper</h1>',
		'<section id="S1" class="ltx_section"><p class="ltx_p">Opening paragraph.</p>',
		body,
		"</section></article></div></body></html>",
	].join("\n");
}

// An <img> as LaTeXML writes one; `size` is its width and height attributes as written, or '' for none.
function img(src: string, size: string) {
	return `<img src="${src}" class="ltx_graphics ltx_centering ltx_img_landscape" ${size} alt="Refer to caption">`;
}

// An SVG <object> as LaTeXML writes one; `size` as for img().
function object(data: string, size: string) {
	return `<object type="image/svg+xml" data="${data}" class="ltx_graphics ltx_centering ltx_img_landscape" ${size}></object>`;
}

// A caption as LaTeXML writes it: the tag ("Figure 1: ") in its own span, then the text.
function caption(tag: string, text: string) {
	return `<figcaption class="ltx_caption ltx_centering"><span class="ltx_tag ltx_tag_figure">${tag}</span>${text}</figcaption>`;
}

// A <figure> holding `graphic`, then a caption with this tag and text.
function figure(graphic: string, tag: string, text: string) {
	return `<figure class="ltx_figure">${graphic}\n${caption(tag, text)}</figure>`;
}

// ---- A Figure 1 is recorded with its caption ----

// The page as the scenario serves it, at ".../2609.35544v1/" with a src of "x1.png", so the image resolves against the
// page's own folder. Words split across a bold span and a line break, and a run of spaces, come out as one line of text.
test("A Figure 1 is recorded with its caption", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		`<figure id="S1.F1" class="ltx_figure">${img("x1.png", 'width="698" height="245"')}\n` +
			caption(
				"Figure 1: ",
				'\n<span class="ltx_text ltx_font_bold">Overview</span> of the   four stages.',
			) +
			"</figure>",
	);
	assert.deepEqual(
		figureFromHtml(html, "https://arxiv.org/html/2609.35544v1/"),
		{
			imageUrl: "https://arxiv.org/html/2609.35544v1/x1.png",
			caption: "Figure 1: Overview of the four stages.",
			width: 698,
			height: 245,
		},
	);
});

// As arXiv serves most pages: at /html/<id>, with versioned srcs.
test("A Figure 1 is recorded with its caption: a versioned src in a page at /html/<id>", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		figure(img("2609.35544v1/x1.png", SHOWN_SIZE), "Figure 1: ", "Overview."),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/x1.png",
		caption: "Figure 1: Overview.",
		width: 548,
		height: 275,
	});
});

// Optional whitespace before "Figure 1" still counts.
test('A Figure 1 is recorded with its caption: whitespace before "Figure 1"', async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		`<figure class="ltx_figure">${img("2609.35544v1/x1.png", SHOWN_SIZE)}` +
			'<figcaption class="ltx_caption">\n   <span class="ltx_tag ltx_tag_figure">Figure 1: </span>Overview.</figcaption></figure>',
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/x1.png",
		caption: "Figure 1: Overview.",
		width: 548,
		height: 275,
	});
});

// Panels with captions of their own sit inside the figure that holds the "Figure 1" caption (97 such panels on the
// measured pages). Figure 1 is the outer figure: its first image, with that image's size, and its own caption, not its
// panels'.
test("A Figure 1 is recorded with its caption: a figure made of captioned panels", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		'<figure id="S1.F1" class="ltx_figure"><div class="ltx_flex_figure">' +
			`<div class="ltx_flex_cell"><figure id="S1.F1.sf1" class="ltx_figure ltx_figure_panel">${img("2609.35544v1/left.png", 'width="240" height="180"')}` +
			`${caption("(a) ", "Before training.")}</figure></div>` +
			`<div class="ltx_flex_cell"><figure id="S1.F1.sf2" class="ltx_figure ltx_figure_panel">${img("2609.35544v1/right.png", 'width="250" height="190"')}` +
			`${caption("(b) ", "After training.")}</figure></div>` +
			`</div>\n${caption("Figure 1: ", "The model before and after training.")}</figure>`,
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/left.png",
		caption: "Figure 1: The model before and after training.",
		width: 240,
		height: 180,
	});
});

// Width and height are whole numbers above 0; decimals are rounded.
test("A Figure 1 is recorded with its caption: decimal sizes are rounded", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		figure(
			img("2609.35544v1/x1.png", 'width="697.6" height="245.2"'),
			"Figure 1: ",
			"Overview.",
		),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/x1.png",
		caption: "Figure 1: Overview.",
		width: 698,
		height: 245,
	});
});

// The image types the page can show, by the src's extension; a query after it doesn't count.
test("A Figure 1 is recorded with its caption: every image type the page shows", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const sources = [
		"x1.png",
		"x1.jpg",
		"x1.jpeg",
		"x1.gif",
		"x1.webp",
		"x1.svg",
		"x1.png?raw=1",
	];
	for (const src of sources) {
		const html = page(
			figure(img(`2609.35544v1/${src}`, SHOWN_SIZE), "Figure 1: ", "Overview."),
		);
		const result: FigureFields = figureFromHtml(html, BASE);
		assert.equal(
			result.imageUrl,
			`https://arxiv.org/html/2609.35544v1/${src}`,
			src,
		);
		assert.equal(result.reason, undefined, src);
	}
});

// ---- An SVG figure in an <object> is recorded too ----

test("An SVG figure in an <object> is recorded too", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		figure(
			object("2609.35544v1/fig1.svg", 'width="977" height="295"'),
			"Figure 1: ",
			"An SVG overview.",
		),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/fig1.svg",
		caption: "Figure 1: An SVG overview.",
		width: 977,
		height: 295,
	});
});

// As 2609.30258 has it (measured): an <object> panel, then an <img> panel. The first in document order is taken.
test("An SVG figure in an <object> is recorded too: an <object> before an <img> in the same figure is the one taken", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		'<figure id="S1.F1" class="ltx_figure"><div class="ltx_flex_figure">' +
			`<div class="ltx_flex_cell"><figure class="ltx_figure ltx_figure_panel">${object("2609.35544v1/hero.svg", 'width="381" height="75"')}</figure></div>` +
			`<div class="ltx_flex_cell"><figure class="ltx_figure ltx_figure_panel">${img("2609.35544v1/gain.png", SHOWN_SIZE)}</figure></div>` +
			`</div>\n${caption("Figure 1: ", "Reconstruction from gradients.")}</figure>`,
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/hero.svg",
		caption: "Figure 1: Reconstruction from gradients.",
		width: 381,
		height: 75,
	});
});

// ---- An image without width and height in the HTML ----

// Without both a width and a height that are numbers above 0, neither is given.
test("An image without both a width and a height above 0 is recorded without a size", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const sizes = {
		"no width or height": "",
		"only a width": 'width="698"',
		"only a height": 'height="245"',
		"a width of 0": 'width="0" height="245"',
	};
	for (const [name, size] of Object.entries(sizes)) {
		const html = page(
			figure(img("2609.35544v1/x1.png", size), "Figure 1: ", "Overview."),
		);
		const result: FigureFields = figureFromHtml(html, BASE);
		assert.equal(
			result.imageUrl,
			"https://arxiv.org/html/2609.35544v1/x1.png",
			name,
		);
		assert.equal(result.caption, "Figure 1: Overview.", name);
		assert.equal(result.width, undefined, name);
		assert.equal(result.height, undefined, name);
	}
});

// ---- Which figure is Figure 1 ----

// As 2610.00309 writes it (measured): "Fig. 1" in a span of its own inside the tag.
test('"Fig. 1" counts as Figure 1', async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		`<figure id="S1.F1" class="ltx_figure">${img("2609.35544v1/Figures/perplexity.png", SHOWN_SIZE)}\n` +
			'<figcaption class="ltx_caption ltx_centering"><span class="ltx_tag ltx_tag_figure">' +
			'<span class="ltx_text" style="font-size:90%;">Fig. 1</span>: </span>' +
			'<span class="ltx_text" style="font-size:90%;">Perplexity with and without the defence.</span></figcaption></figure>',
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/Figures/perplexity.png",
		caption: "Fig. 1: Perplexity with and without the defence.",
		width: 548,
		height: 275,
	});
});

// The scenario's page: "Figure 1.2" first, then "Figure 2", both with images, and no Figure 1.
test('A chapter-numbered "Figure 1.2" is not Figure 1', async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		figure(img("2609.35544v1/x1.png", SHOWN_SIZE), "Figure 1.2: ", "Detail.") +
			"\n" +
			figure(img("2609.35544v1/x2.png", SHOWN_SIZE), "Figure 2: ", "Results."),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		reason: "it has no Figure 1",
	});
});

// "Fig. 1.3" is not Figure 1 either; a real Figure 1 after a chapter-numbered one is taken.
test('A chapter-numbered "Figure 1.2" is not Figure 1: a Figure 1 after it is taken', async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const html = page(
		figure(img("2609.35544v1/x1.png", SHOWN_SIZE), "Fig. 1.3: ", "Detail.") +
			"\n" +
			figure(
				img("2609.35544v1/x2.png", SHOWN_SIZE),
				"Figure 1.2: ",
				"More detail.",
			) +
			"\n" +
			figure(img("2609.35544v1/x3.png", SHOWN_SIZE), "Figure 1: ", "Overview."),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/x3.png",
		caption: "Figure 1: Overview.",
		width: 548,
		height: 275,
	});
});

// What may follow "Figure 1" and still be Figure 1: a letter ("Figure 1a"), a colon, or a full stop that no digit follows.
test('A chapter-numbered "Figure 1.2" is not Figure 1: "Figure 1a" and "Figure 1." are', async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const tags = ["Figure 1a: ", "Figure 1. ", "Figure 1: "];
	for (const tag of tags) {
		const html = page(
			figure(img("2609.35544v1/x1.png", SHOWN_SIZE), tag, "Overview."),
		);
		const result: FigureFields = figureFromHtml(html, BASE);
		assert.equal(
			result.imageUrl,
			"https://arxiv.org/html/2609.35544v1/x1.png",
			tag,
		);
	}
});

// The first <figure> is often not Figure 1: on 2609.35686 and 2609.07746 it is a table (measured). Then an unnumbered
// teaser, then Figure 1.
test("The first figure is skipped when it isn't Figure 1", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const table =
		'<figure id="S3.T1" class="ltx_table"><figcaption class="ltx_caption ltx_centering"><span class="ltx_tag ltx_tag_table">Table 1: </span>' +
		'Scores.</figcaption><table class="ltx_tabular"><tr><td>0.9</td></tr></table></figure>';
	const teaser = `<figure class="ltx_figure">${img("2609.35544v1/x1.png", SHOWN_SIZE)}<figcaption class="ltx_caption">Our method at a glance.</figcaption></figure>`;
	const figure1 = figure(
		img("2609.35544v1/x2.png", 'width="600" height="300"'),
		"Figure 1: ",
		"The four stages in detail.",
	);
	assert.deepEqual(
		figureFromHtml(page(`${table}\n${teaser}\n${figure1}`), BASE),
		{
			imageUrl: "https://arxiv.org/html/2609.35544v1/x2.png",
			caption: "Figure 1: The four stages in detail.",
			width: 600,
			height: 300,
		},
	);
});

// ---- Math in the caption becomes TeX the page typesets ----

// alttext holds LaTeXML's TeX, entities and all; the text around it has entities too.
test("Math in the caption becomes TeX the page typesets", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const alpha =
		'<math id="S1.F1.m1" class="ltx_Math" alttext="\\alpha=0.5" display="inline" intent=":literal"><semantics>' +
		'<mrow><mi>α</mi><mo>=</mo><mn>0.5</mn></mrow><annotation encoding="application/x-tex">\\alpha=0.5</annotation></semantics></math>';
	const bound =
		'<math id="S1.F1.m2" class="ltx_Math" alttext="x&lt;10^{-3}" display="inline"><semantics>' +
		"<mrow><mi>x</mi><mo>&lt;</mo><msup><mn>10</mn><mrow><mo>−</mo><mn>3</mn></mrow></msup></mrow>" +
		'<annotation encoding="application/x-tex">x&lt;10^{-3}</annotation></semantics></math>';
	const html = page(
		figure(
			img("2609.35544v1/x1.png", SHOWN_SIZE),
			"Figure 1: ",
			`Accuracy at ${alpha} over training, &amp; loss below ${bound} on the model&#8217;s data.`,
		),
	);
	assert.deepEqual(figureFromHtml(html, BASE), {
		imageUrl: "https://arxiv.org/html/2609.35544v1/x1.png",
		caption:
			"Figure 1: Accuracy at $\\alpha=0.5$ over training, & loss below $x<10^{-3}$ on the model’s data.",
		width: 548,
		height: 275,
	});
});

// ---- A paper without a Figure 1 image gets no figure ----

// The scenario's Examples rows, as measured on arXiv (2 maths papers with no <figure>, 2608.27340's table,
// 2609.26419's inline TikZ, 2609.07746's empty <img>, then an EPS file), then more measured or likely shapes: a
// Figure 1 that is a caption alone (2609.33439, 2609.39625), figures numbered 12 and up with no Figure 1, and a PDF
// file. "Figure 12" and "Figure 10" are not Figure 1, so a later figure's image is never taken in its place.
test("A paper without a Figure 1 image gets no figure", async () => {
	const { figureFromHtml }: typeof Figure = await import(SCRIPT.href);
	const later = figure(
		img("2609.35544v1/x10.png", SHOWN_SIZE),
		"Figure 10: ",
		"Later results.",
	);
	const cases = {
		"no figure at all": {
			body: '<p class="ltx_p">A maths paper.</p>',
			reason: "it has no Figure 1",
		},
		"a Figure 1 that is a table": {
			body: figure(
				'<table class="ltx_tabular"><tr><td>Capabilities framing</td></tr></table>',
				"Figure 1: ",
				"Two framings.",
			),
			reason: "its Figure 1 holds no image file",
		},
		'a Figure 1 drawn inline as <svg class="ltx_picture">': {
			body: figure(
				'<svg class="ltx_picture" viewBox="0 0 183.05 79.71" width="183.05" height="79.71">' +
					'<g><path d="M 2.94 0 Z"></path><foreignObject width="74" height="8"><span>Other controls</span></foreignObject></g></svg>',
				"Figure 1: ",
				"The controls compared.",
			),
			reason: "its Figure 1 holds no image file",
		},
		'a Figure 1 with <img src="" class="ltx_missing_image">': {
			body: figure(
				'<img src="" class="ltx_graphics ltx_centering ltx_missing ltx_missing_image" alt="Refer to caption">',
				"Figure 1: ",
				"Layer-wise results.",
			),
			reason: "its Figure 1 holds no image file",
		},
		'a Figure 1 holding <img src="x1.eps">': {
			body: figure(
				img("2609.35544v1/x1.eps", SHOWN_SIZE),
				"Figure 1: ",
				"Overview.",
			),
			reason: "its image isn't PNG, JPEG, GIF, WebP or SVG",
		},
		"a Figure 1 that is a caption alone, then Figure 10 with an image": {
			body: `<figure class="ltx_figure ltx_align_center">${caption("Figure 1: ", "Raven performance overview.")}</figure>\n${later}`,
			reason: "its Figure 1 holds no image file",
		},
		"Figure 12 and Figure 10 with images, and no Figure 1": {
			body:
				figure(
					img("2609.35544v1/x12.png", SHOWN_SIZE),
					"Figure 12: ",
					"Ablations.",
				) +
				"\n" +
				later,
			reason: "it has no Figure 1",
		},
		"a Figure 1 holding a PDF file": {
			body: figure(
				img("2609.35544v1/x1.pdf", SHOWN_SIZE),
				"Figure 1: ",
				"Overview.",
			),
			reason: "its image isn't PNG, JPEG, GIF, WebP or SVG",
		},
		// A figure outside arXiv's HTML is not taken: an image the page and
		// entry-checks.ts would refuse is not written.
		"a Figure 1 whose image is on arXiv but outside its HTML pages": {
			body: figure(
				img("https://arxiv.org/abs/x1.png", SHOWN_SIZE),
				"Figure 1: ",
				"Overview.",
			),
			reason: "its image is not under arXiv's HTML pages",
		},
		"a Figure 1 whose image is a data: address": {
			body: figure(
				img("data:image/png;base64,AAAA/x1.png", SHOWN_SIZE),
				"Figure 1: ",
				"Overview.",
			),
			reason: "its image is not under arXiv's HTML pages",
		},
	};
	for (const [name, figureCase] of Object.entries(cases)) {
		assert.deepEqual(
			figureFromHtml(page(figureCase.body), BASE),
			{ reason: figureCase.reason },
			name,
		);
	}
});
