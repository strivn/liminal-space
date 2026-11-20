// Small PDFs built by hand for the fulltext tests: text only, in Helvetica, placed line by line where the caller says.
// Helvetica is one of the 14 fonts every PDF reader carries, so nothing is embedded and a PDF is under 2 KB.
//
// A PDF is a list of numbered objects (catalog, page tree, font, then each page and its content stream), followed by a
// cross-reference table that gives each object's byte offset, which readers use to find them. The offsets are counted
// here while the objects are written.

const PAGE_WIDTH = 612; // US Letter, in points
const PAGE_HEIGHT = 792;
const FONT_SIZE = 10;

// One line of text on a page, set at x, y: points from the bottom-left corner.
type PdfLine = { x: number; y: number; text: string };

// Text inside a PDF string literal: backslashes and parentheses are escaped. Only ASCII is written, so that bytes and
// characters are the same and the stream lengths below are right.
function pdfString(text: string): string {
	if (!/^[\x20-\x7e]*$/.test(text)) {
		throw new Error(
			`makePdf writes printable ASCII only, got ${JSON.stringify(text)}`,
		);
	}
	const escaped = text
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
	return `(${escaped})`;
}

// The drawing instructions for one page: each line's text set at its own x, y (points from the bottom-left corner).
function pageContent(lines: PdfLine[]): string {
	const parts = ["BT", `/F1 ${FONT_SIZE} Tf`];
	for (const line of lines) {
		parts.push(`1 0 0 1 ${line.x} ${line.y} Tm`);
		parts.push(`${pdfString(line.text)} Tj`);
	}
	parts.push("ET");
	return parts.join("\n");
}

// A PDF with one page per item of `pages`; each page is a list of { x, y, text }. Returns its bytes.
function makePdf(pages: PdfLine[][]): Buffer {
	// Object numbers: 1 catalog, 2 page tree, 3 font, then for page i (from 0) 4 + 2i the page and 5 + 2i its content.
	const objects: string[] = [];
	const pageRefs: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		pageRefs.push(`${4 + 2 * i} 0 R`);
	}
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(
		"<< /Type /Pages /Kids [" +
			pageRefs.join(" ") +
			"] /Count " +
			pages.length +
			" >>",
	);
	objects.push(
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	);
	for (let i = 0; i < pages.length; i++) {
		const contentNumber = 5 + 2 * i;
		const page = pages[i];
		if (page === undefined) {
			throw new Error(`no page ${i + 1}`);
		}
		const content = pageContent(page);
		objects.push(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
				PAGE_WIDTH +
				" " +
				PAGE_HEIGHT +
				"]" +
				" /Resources << /Font << /F1 3 0 R >> >> /Contents " +
				contentNumber +
				" 0 R >>",
		);
		objects.push(
			"<< /Length " +
				content.length +
				" >>\nstream\n" +
				content +
				"\nendstream",
		);
	}

	// Write the objects, noting where each starts.
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}

	// The cross-reference table: entry 0 is the head of the free list, then one 20-byte line per object.
	const xrefStart = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n`;
	pdf += "0000000000 65535 f \n";
	for (const offset of offsets) {
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
	pdf += `startxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

// A two-page PDF for an arXiv id: page 1 reads "Page one of <id>", page 2 reads "Page two of <id>".
function twoPagePdf(id: string): Buffer {
	return makePdf([
		[{ x: 72, y: 720, text: `Page one of ${id}` }],
		[{ x: 72, y: 720, text: `Page two of ${id}` }],
	]);
}

export { twoPagePdf };
