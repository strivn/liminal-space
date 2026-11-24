// The published-version script, scripts/scout/proceedings/camera-ready.ts: reading proceedings files, matching papers
// to them, and filling each paper's camera_ready field.
import { expect, test } from "vitest";
import { proceedingsLines } from "../../scripts/scout/plan/interests.ts";
import {
	matchPublished,
	readProceedings,
} from "../../scripts/scout/proceedings/camera-ready.ts";

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
test.todo(
	"A FAccT paper's published version is its DOI from arXiv, else the Crossref record in the FAccT proceedings with the same title and first author",
);
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
test.todo(
	"Only papers whose venue names the proceedings' conference and year are matched against them",
);
test.todo(
	"The morning run fills the published version of today's papers that have a venue",
);
test.todo(
	"The weekly check fills every paper with a venue and no published version yet",
);
test.todo("A paper that already has a published version keeps it");
test.todo(
	"Each proceedings file is fetched once per run, however many papers it fills",
);
test.todo(
	"A proceedings site that refuses or times out is named, and its papers wait for the next check",
);
test.todo("A conference with no proceedings line is skipped and named");
test.todo(
	"security: a published version is recorded only as an https page on its proceedings' own site or doi.org",
);
