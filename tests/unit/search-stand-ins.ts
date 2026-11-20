// Stand-ins on 127.0.0.1 for what scripts/scout/search.ts asks: arXiv's API, Google News's RSS search and the conference lists'
// pages. A test sets what they answer on the returned object and reads what they were asked.
import type { IncomingMessage } from "node:http";
import { serve } from "./local-server.ts";

export type Answer = {
	status: number;
	body: string;
	headers?: Record<string, string>;
};

// One request to arXiv's API as the plan makes it.
export type ArxivRequest = {
	url: string;
	query: string | null;
	sortBy: string | null;
	start: number;
	maxResults: number;
	ids: string[];
};

export type ArxivPaper = {
	id: string;
	title: string;
	published: string;
	comment?: string;
	journal?: string;
	abstract?: string;
	authors?: string[];
	category?: string;
};

function xmlText(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// One <entry> of arXiv's Atom feed.
export function atomEntry(paper: ArxivPaper): string {
	const category = paper.category ?? "cs.AI";
	const authors = (paper.authors ?? ["Ada Example"])
		.map((name) => `<author><name>${xmlText(name)}</name></author>`)
		.join("");
	let extra = "";
	if (paper.comment !== undefined) {
		extra += `<arxiv:comment>${xmlText(paper.comment)}</arxiv:comment>`;
	}
	if (paper.journal !== undefined) {
		extra += `<arxiv:journal_ref>${xmlText(paper.journal)}</arxiv:journal_ref>`;
	}
	return (
		`<entry><id>http://arxiv.org/abs/${paper.id}v1</id><title>${xmlText(paper.title)}</title>` +
		`<updated>${paper.published}T00:00:00Z</updated><link href="https://arxiv.org/abs/${paper.id}v1" rel="alternate" type="text/html"/>` +
		`<summary>${xmlText(paper.abstract ?? `Abstract of ${paper.id}.`)}</summary>` +
		`<category term="${category}" scheme="http://arxiv.org/schemas/atom"/>` +
		`<published>${paper.published}T00:00:00Z</published>${extra}` +
		`<arxiv:primary_category term="${category}"/>${authors}</entry>`
	);
}

// arXiv's Atom feed holding `entries`, with `total` as the number of results the query has.
export function atomFeed(entries: string[], total = entries.length): string {
	return (
		'<?xml version="1.0" encoding="UTF-8"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" ' +
		'xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">' +
		`<opensearch:totalResults>${total}</opensearch:totalResults>${entries.join("")}</feed>`
	);
}

// The feed of a page of `papers`: the part of the list `request` asks for, with the list's length as the total.
export function pageOf(papers: ArxivPaper[], request: ArxivRequest): Answer {
	const page = papers.slice(request.start, request.start + request.maxResults);
	return {
		status: 200,
		body: atomFeed(page.map(atomEntry), papers.length),
	};
}

// A Google News RSS item.
export function newsItem(
	headline: string,
	source: string,
	published: Date | null,
): string {
	let date = "";
	if (published !== null) {
		date = `<pubDate>${published.toUTCString()}</pubDate>`;
	}
	return `<item><title>${xmlText(headline)} - ${xmlText(source)}</title>${date}<source url="https://example.org">${xmlText(source)}</source></item>`;
}

export function rss(items: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>news</title>${items.join("")}</channel></rss>`;
}

export type StandIns = {
	base: string;
	arxiv: {
		requests: ArxivRequest[];
		answer: (request: ArxivRequest) => Answer;
	};
	news: {
		requests: string[];
		answer: (query: string, url: string) => Answer;
	};
	// Pages by path, such as a conference list; a path not listed answers HTTP 404.
	pages: Record<string, (incoming: IncomingMessage) => Answer>;
	pageRequests: { path: string; headers: IncomingMessage["headers"] }[];
	// Everything asked of any path, in order.
	all: string[];
};

const EMPTY: Answer = { status: 200, body: atomFeed([]) };

// Starts the stand-ins on one server: arXiv at <base>/api/query, Google News at <base>/rss, pages at their paths.
export async function startStandIns(): Promise<StandIns> {
	const stand: StandIns = {
		base: "",
		arxiv: { requests: [], answer: () => EMPTY },
		news: { requests: [], answer: () => ({ status: 200, body: rss([]) }) },
		pages: {},
		pageRequests: [],
		all: [],
	};
	stand.base = await serve((incoming, response) => {
		const url = new URL(String(incoming.url), "http://127.0.0.1");
		stand.all.push(String(incoming.url));
		let answer: Answer = { status: 404, body: "" };
		if (url.pathname === "/api/query") {
			const request: ArxivRequest = {
				url: String(incoming.url),
				query: url.searchParams.get("search_query"),
				sortBy: url.searchParams.get("sortBy"),
				start: Number(url.searchParams.get("start") ?? 0),
				maxResults: Number(url.searchParams.get("max_results") ?? 10),
				ids: (url.searchParams.get("id_list") ?? "")
					.split(",")
					.filter((id) => id !== ""),
			};
			stand.arxiv.requests.push(request);
			answer = stand.arxiv.answer(request);
		} else if (url.pathname === "/rss") {
			stand.news.requests.push(String(incoming.url));
			answer = stand.news.answer(
				url.searchParams.get("q") ?? "",
				String(incoming.url),
			);
		} else {
			const page = stand.pages[url.pathname];
			stand.pageRequests.push({
				path: url.pathname,
				headers: incoming.headers,
			});
			if (page !== undefined) {
				answer = page(incoming);
			}
		}
		response.writeHead(answer.status, {
			"content-type": "text/plain; charset=utf-8",
			...answer.headers,
		});
		response.end(answer.body);
	});
	return stand;
}
