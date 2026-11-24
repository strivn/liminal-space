// The published-version script, scripts/scout/proceedings/camera-ready.ts: reading proceedings files, matching papers
// to them, and filling each paper's camera_ready field.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { proceedingsLines } from "../../scripts/scout/plan/interests.ts";
import {
	matchPublished,
	readProceedings,
} from "../../scripts/scout/proceedings/camera-ready.ts";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SCRIPT = scriptPath("scout/proceedings/camera-ready.ts");
const TODAY = "2026-11-24";
const PMLR = "https://proceedings.mlr.press/v306/assets/bib/bibliography.bib";
const FACCT_CONTAINER =
	"Proceedings of the 2026 ACM Conference on Fairness, Accountability, and Transparency";

afterEach(closeServers);
afterAll(removeTempFolders);

const ICML_BIB = `@InProceedings{pmlr-v306-shapira26a,
  title = {How {RLHF} Amplifies Sycophancy},
  author = {Shapira, Itai and Benade, Gerdus},
  url = {https://proceedings.mlr.press/v306/shapira26a.html}
}
@InProceedings{pmlr-v306-old26a,
  title = {An Older Paper},
  author = {Older, Ada},
  url = {https://proceedings.mlr.press/v306/old26a.html}
}
@InProceedings{pmlr-v306-elsewhere26a,
  title = {A Paper Linked Elsewhere},
  author = {Away, Ben},
  url = {https://elsewhere.example/paper.html}
}
`;

function crossrefAnswer(container: string) {
	return JSON.stringify({
		status: "ok",
		message: {
			items: [
				{
					DOI: "10.1145/3805689.3806475",
					title: [
						"Crowding Out the Noise: Algorithmic Collective Action Under Differential Privacy",
					],
					"container-title": [container],
					author: [{ given: "Rushabh", family: "Solanki" }],
				},
			],
		},
	});
}

function paperEntry(n: number, title: string, author: string, venue: string) {
	return {
		id: `arxiv:2601.0000${n}`,
		type: "paper",
		title: title,
		authors: [author],
		url: `https://arxiv.org/abs/2601.0000${n}`,
		venue: venue,
	};
}

// A proceedings stand-in, its requests counted.
async function proceedingsStandIn(
	answers: Record<string, { status: number; body: string }>,
) {
	const requests: string[] = [];
	const base = await serve((incoming, outgoing) => {
		const path = new URL(incoming.url ?? "/", "http://x").pathname;
		requests.push(path);
		const answer = answers[path] ?? { status: 404, body: "" };
		outgoing.writeHead(answer.status);
		outgoing.end(answer.body);
	});
	return { base, requests };
}

// Interests, digests and a run.
async function fill(
	lines: unknown[][],
	answers: Record<string, { status: number; body: string }>,
	args: string[] = [],
) {
	const folder = tempFolder("camera-ready-");
	const interests = join(folder, "interests.md");
	writeFileSync(
		interests,
		`## Proceedings
- ICML 2026: ${PMLR}
- FAccT 2026: https://api.crossref.org/works?filter=prefix:10.1145 (${FACCT_CONTAINER})
- PETS 2026: https://petsymposium.org/popets/2026/
`,
	);
	const file = join(folder, "digests.js");
	const dates = ["2026-11-01", TODAY];
	writeFileSync(
		file,
		`${lines.map((entries, i) => digestText(dates[i] ?? TODAY, entries)).join("\n")}\n`,
	);
	const stand = await proceedingsStandIn(answers);
	const ran = await runScript(SCRIPT, [file, ...args], {
		INTERESTS_FILE: interests,
		PROCEEDINGS_BASE: stand.base,
		LIMINAL_TODAY: TODAY,
		CROSSREF_GAP_MS: "0",
	});
	const written = readFileSync(file, "utf8").trim().split("\n");
	return { ran, written: written.map(entriesOfLine), requests: stand.requests };
}

const ICML_FILE = {
	"/v306/assets/bib/bibliography.bib": { status: 200, body: ICML_BIB },
};

test("The proceedings lines in interests.md are read with their conference and address", () => {
	const markdown = `## Conferences
- ICML: https://icml.cc/static/virtual/data/icml-2026-orals-posters.json

## Proceedings
Where each conference edition publishes its final papers.
- ICML 2026: https://proceedings.mlr.press/v306/assets/bib/bibliography.bib
- FAccT 2026: https://api.crossref.org/works?filter=prefix:10.1145 (Proceedings of FAccT 2026)
- PETS 2026: ftp://petsymposium.org/popets/2026/

## Surprise (one per day)`;
	expect(proceedingsLines(markdown)).toEqual([
		{
			venue: "ICML 2026",
			url: "https://proceedings.mlr.press/v306/assets/bib/bibliography.bib",
			container: null,
		},
		{
			venue: "FAccT 2026",
			url: "https://api.crossref.org/works?filter=prefix:10.1145",
			container: "Proceedings of FAccT 2026",
		},
	]);
});

test("A PMLR BibTeX volume is read into each paper's title, first author and page", () => {
	const bib = `@Proceedings{ICML2026,
  title =     {Proceedings of the 43rd International Conference on Machine Learning},
  volume =    306
}

@InProceedings{pmlr-v306-shapira26a,
  title = 	 {How {RLHF} Amplifies Sycophancy},
  author =       {Shapira, Itai and Benade, Gerdus and Procaccia, Ariel D.},
  pdf = 	 {https://raw.githubusercontent.com/mlresearch/v306/main/assets/shapira26a/shapira26a.pdf},
  url = 	 {https://proceedings.mlr.press/v306/shapira26a.html}
}
`;
	expect(
		readProceedings(
			"pmlr-bib",
			bib,
			"https://proceedings.mlr.press/v306/x.bib",
		),
	).toEqual([
		{
			title: "How RLHF Amplifies Sycophancy",
			authors: ["Itai Shapira", "Gerdus Benade", "Ariel D. Procaccia"],
			url: "https://proceedings.mlr.press/v306/shapira26a.html",
		},
	]);
});

test("An ACL Anthology BibTeX volume is read into each paper's title, first author and page", () => {
	const bib = `@proceedings{acl-2026-long,
    title = "Proceedings of the 64th Annual Meeting",
    url = "https://aclanthology.org/2026.acl-long.0/"
}
@inproceedings{ilic-etal-2026-powerful,
    title = "Powerful Training-Free Membership Inference Against Fine-Tuned Autoregressive Language Models",
    author = "Ili{\\'c}, David  and
      Stanojevi{\\'c}, David",
    url = "https://aclanthology.org/2026.acl-long.640/",
}
`;
	expect(
		readProceedings(
			"anthology-bib",
			bib,
			"https://aclanthology.org/volumes/x.bib",
		),
	).toEqual([
		{
			title:
				"Powerful Training-Free Membership Inference Against Fine-Tuned Autoregressive Language Models",
			authors: ["David Ilic", "David Stanojevic"],
			url: "https://aclanthology.org/2026.acl-long.640/",
		},
	]);
});

test("A proceedings.neurips.cc, proceedings.iclr.cc or proceedings.colm.cc listing is read into each paper's title, authors and page", () => {
	const page = `<ul><li class="conference" data-track="conference">
    <div class="paper-content">
        <a title="paper title" href="/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html">Attention is All you Need</a>
        <span class="paper-authors">Ashish Vaswani, Noam Shazeer, Niki Parmar</span>
    </div></li></ul>`;
	expect(
		readProceedings(
			"proceedings-listing",
			page,
			"https://proceedings.neurips.cc/paper_files/paper/2017",
		),
	).toEqual([
		{
			title: "Attention is All you Need",
			authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
			url: "https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html",
		},
	]);
});

test("A PoPETs volume index is read into each paper's title, first author and page", () => {
	const page = `<li><b><a href="popets-2026-0001.pdf">Editors&#x27; Introduction</a></b><br />
<li><b><a href="../2026/popets-2026-0002.php">Gaze3P: Gaze-Based Prediction of User-Perceived Privacy</a></b>
    [<a href="popets-2026-0002.pdf">PDF</a>]<br />
    <i>Mayar Elfares (University of Stuttgart, Germany), Ralf Küsters (University of Stuttgart, Germany)</i></li>`;
	expect(
		readProceedings(
			"popets-index",
			page,
			"https://petsymposium.org/popets/2026/",
		),
	).toEqual([
		{
			title: "Gaze3P: Gaze-Based Prediction of User-Perceived Privacy",
			authors: ["Mayar Elfares", "Ralf Küsters"],
			url: "https://petsymposium.org/popets/2026/popets-2026-0002.php",
		},
	]);
});

test("AAAI's OAI-PMH records for AIES are read into each paper's title, first author and page", () => {
	const xml = `<ListRecords><record><header><identifier>oai:ojs.aaai.org:article/43325</identifier></header>
<metadata><oai_dc:dc>
	<dc:title xml:lang="en-US">Rules or Character? Scaling Laws for AI Safety Design (Extended Abstract)</dc:title>
	<dc:creator>Lauscher, Anne</dc:creator>
	<dc:creator>A Pranav,  </dc:creator>
	<dc:identifier>https://ojs.aaai.org/index.php/AIES/article/view/43325</dc:identifier>
	<dc:identifier>10.1609/aies.v9i1.43325</dc:identifier>
</oai_dc:dc></metadata></record></ListRecords>`;
	expect(
		readProceedings("oai-pmh", xml, "https://ojs.aaai.org/index.php/AIES/oai"),
	).toEqual([
		{
			title:
				"Rules or Character? Scaling Laws for AI Safety Design (Extended Abstract)",
			authors: ["Anne Lauscher", "A Pranav"],
			url: "https://ojs.aaai.org/index.php/AIES/article/view/43325",
		},
	]);
});
test("A FAccT paper's published version is the Crossref record in the FAccT proceedings with the same title and first author", async () => {
	const facct = paperEntry(
		2,
		"Crowding Out the Noise: Algorithmic Collective Action Under Differential Privacy",
		"Rushabh Solanki",
		"FAccT 2026",
	);
	const inFacct = await fill([[], [facct]], {
		"/works": { status: 200, body: crossrefAnswer(FACCT_CONTAINER) },
	});
	expect(inFacct.written[1]?.[0]?.camera_ready).toEqual({
		url: "https://doi.org/10.1145/3805689.3806475",
		venue: "FAccT 2026",
		from: "https://api.crossref.org/works?filter=prefix:10.1145",
	});
	const elsewhere = await fill([[], [facct]], {
		"/works": { status: 200, body: crossrefAnswer("Proceedings of CHI 2026") },
	});
	expect(elsewhere.written[1]?.[0]?.camera_ready).toBeUndefined();
});
const LISTED = [
	{
		title: "Attention is All you Need",
		authors: ["Ashish Vaswani", "Noam Shazeer"],
		url: "https://proceedings.neurips.cc/attention.html",
	},
	{
		title: "Small Transformers Don’t Need LayerNorm at Inference Time",
		authors: ["Luca Baroni", "Galvin Khara"],
		url: "https://proceedings.iclr.cc/layernorm.html",
	},
	{
		title: "Expert Evaluation and the Limits of Human Feedback",
		authors: ["Kiana Jafari Meimandi", "Paul Rust"],
		url: "https://doi.org/10.1145/3805689.3812332",
	},
];

test("A paper matches its published version by its normalised title and its first author's surname", () => {
	expect(
		matchPublished(
			{ title: "Attention Is All You Need", authors: ["Ashish Vaswani"] },
			LISTED,
		)?.url,
	).toBe("https://proceedings.neurips.cc/attention.html");
	expect(
		matchPublished(
			{
				title: "Expert Evaluation and the Limits of Human Feedback",
				authors: ["Kiana Jafari"],
			},
			LISTED,
		)?.url,
	).toBe("https://doi.org/10.1145/3805689.3812332");
});

test("A camera-ready title with small edits matches when most of its words and its first two surnames agree", () => {
	const paper = {
		title: "Transformers Don't Need LayerNorm at Inference Time",
		authors: ["Luca Baroni", "Galvin Khara", "Joel Schaeffer"],
	};
	expect(matchPublished(paper, LISTED)?.url).toBe(
		"https://proceedings.iclr.cc/layernorm.html",
	);
	expect(
		matchPublished(
			{ ...paper, authors: ["Luca Baroni", "Someone Else"] },
			LISTED,
		),
	).toBeNull();
});

test("Two papers with the same title but different first authors do not match", () => {
	expect(
		matchPublished(
			{ title: "Attention Is All You Need", authors: ["Yann LeCun"] },
			LISTED,
		),
	).toBeNull();
});
test("Only papers whose venue names the proceedings' conference and year are matched against them", async () => {
	const { written } = await fill(
		[
			[],
			[
				paperEntry(
					1,
					"How RLHF Amplifies Sycophancy",
					"Itai Shapira",
					"ICML 2025",
				),
				paperEntry(
					2,
					"How RLHF Amplifies Sycophancy",
					"Itai Shapira",
					"NeurIPS 2026",
				),
			],
		],
		ICML_FILE,
	);
	expect(written[1]?.map((entry) => entry.camera_ready)).toEqual([
		undefined,
		undefined,
	]);
});
test("The morning run fills the published version of today's papers that have a venue", async () => {
	const { ran, written } = await fill(
		[
			[paperEntry(1, "An Older Paper", "Ada Older", "ICML 2026")],
			[
				paperEntry(
					2,
					"How RLHF Amplifies Sycophancy",
					"Itai Shapira",
					"ICML 2026",
				),
				{
					...paperEntry(3, "No Venue Here", "Ada Older", "ICML 2026"),
					venue: undefined,
				},
			],
		],
		ICML_FILE,
	);
	expect(ran.code, ran.stderr).toBe(0);
	expect(written[1]?.[0]?.camera_ready).toEqual({
		url: "https://proceedings.mlr.press/v306/shapira26a.html",
		venue: "ICML 2026",
		from: PMLR,
	});
	expect(written[1]?.[1]?.camera_ready).toBeUndefined();
	expect(written[0]?.[0]?.camera_ready).toBeUndefined();
});
test("The weekly check fills every paper with a venue and no published version yet", async () => {
	const { written } = await fill(
		[
			[paperEntry(1, "An Older Paper", "Ada Older", "ICML 2026")],
			[
				paperEntry(
					2,
					"How RLHF Amplifies Sycophancy",
					"Itai Shapira",
					"ICML 2026",
				),
			],
		],
		ICML_FILE,
		["--all"],
	);
	expect(written.map((line) => line[0]?.camera_ready)).toMatchObject([
		{ url: "https://proceedings.mlr.press/v306/old26a.html" },
		{ url: "https://proceedings.mlr.press/v306/shapira26a.html" },
	]);
});
test("A paper that already has a published version keeps it", async () => {
	const kept = {
		url: "https://proceedings.mlr.press/v306/kept.html",
		venue: "ICML 2026",
		from: PMLR,
	};
	const { written, requests } = await fill(
		[
			[],
			[
				{
					...paperEntry(
						2,
						"How RLHF Amplifies Sycophancy",
						"Itai Shapira",
						"ICML 2026",
					),
					camera_ready: kept,
				},
			],
		],
		ICML_FILE,
	);
	expect(written[1]?.[0]?.camera_ready).toEqual(kept);
	expect(requests).toEqual([]);
});
test("Each proceedings file is fetched once per run, however many papers it fills", async () => {
	const { written, requests } = await fill(
		[
			[paperEntry(1, "An Older Paper", "Ada Older", "ICML 2026")],
			[
				paperEntry(
					2,
					"How RLHF Amplifies Sycophancy",
					"Itai Shapira",
					"ICML 2026",
				),
			],
		],
		ICML_FILE,
		["--all"],
	);
	expect(written.flat().filter((entry) => entry.camera_ready)).toHaveLength(2);
	expect(requests).toEqual(["/v306/assets/bib/bibliography.bib"]);
});
test("A proceedings site that refuses or times out is named, and its papers wait for the next check", async () => {
	const pets = paperEntry(
		4,
		"Gaze3P: Gaze-Based Prediction",
		"Mayar Elfares",
		"PETS 2026",
	);
	const icml = paperEntry(
		2,
		"How RLHF Amplifies Sycophancy",
		"Itai Shapira",
		"ICML 2026",
	);
	const { ran, written } = await fill([[], [pets, icml]], {
		...ICML_FILE,
		"/popets/2026/": { status: 503, body: "" },
	});
	expect(ran.code).toBe(0);
	expect(ran.stderr).toContain(
		"https://petsymposium.org/popets/2026/ not read: answered HTTP 503; its papers wait for the next check",
	);
	expect(written[1]?.[0]?.camera_ready).toBeUndefined();
	expect(written[1]?.[1]?.camera_ready).toBeDefined();
});
test("A conference with no proceedings line is skipped and named", async () => {
	const { ran, written, requests } = await fill(
		[
			[],
			[
				paperEntry(
					5,
					"A Workshop Paper",
					"Ada Older",
					"NeurIPS 2026 Workshop (BiAlign)",
				),
			],
		],
		ICML_FILE,
	);
	expect(ran.code).toBe(0);
	expect(ran.stderr).toContain(
		"no proceedings line in interests.md for NeurIPS Workshop (BiAlign) 2026",
	);
	expect(written[1]?.[0]?.camera_ready).toBeUndefined();
	expect(requests).toEqual([]);
});
test("security: a published version is recorded only as an https page on its proceedings' own site or doi.org", async () => {
	const { written } = await fill(
		[[], [paperEntry(6, "A Paper Linked Elsewhere", "Ben Away", "ICML 2026")]],
		ICML_FILE,
	);
	expect(written[1]?.[0]?.camera_ready).toBeUndefined();
});
