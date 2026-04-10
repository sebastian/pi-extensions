import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ResearchSource } from "./utils.ts";

interface SearchResult extends ResearchSource {
	snippet: string;
}

interface FetchResult extends ResearchSource {
	description?: string;
	excerpt: string;
}

interface WebResearchDetails {
	ok: boolean;
	action: "search" | "fetch";
	query?: string;
	url?: string;
	results?: SearchResult[];
	fetched?: FetchResult;
	sources: ResearchSource[];
	error?: string;
}

const USER_AGENT = "Mozilla/5.0 (compatible; pi-guided-discovery/1.0; +https://pi.dev)";
const MAX_FETCH_CHARS = 12_000;

const WebResearchParams = Type.Object({
	action: StringEnum(["search", "fetch"] as const),
	query: Type.Optional(
		Type.String({
			description: "Search query to run. Use for official docs, comparable products, API research, or current best practices.",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "URL to fetch and summarize. Use after search when you want the contents of a specific source.",
		}),
	),
	maxResults: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 8,
			description: "How many search results to return for search queries. Defaults to 5.",
		}),
	),
});

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeUrl(url: string): string {
	const trimmed = url.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (trimmed.startsWith("//")) return `https:${trimmed}`;
	return `https://${trimmed}`;
}

function decodeDuckDuckGoUrl(url: string): string {
	const normalized = normalizeUrl(url);
	try {
		const parsed = new URL(normalized);
		const redirectTarget = parsed.searchParams.get("uddg");
		return redirectTarget ? decodeURIComponent(redirectTarget) : parsed.toString();
	} catch {
		return normalized;
	}
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function extractMetaDescription(html: string): string | undefined {
	const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
	return match?.[1] ? stripTags(match[1]) : undefined;
}

function htmlToText(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
			.replace(/<(br|\/p|\/div|\/li|\/section|\/article|\/h\d)>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function searchWeb(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "text/html,application/xhtml+xml",
			"accept-language": "en-US,en;q=0.9",
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Search request failed with ${response.status}`);
	}

	const html = await response.text();
	const pattern =
		/class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const results: SearchResult[] = [];
	const seen = new Set<string>();

	for (const match of html.matchAll(pattern)) {
		const url = decodeDuckDuckGoUrl(match[1]);
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({
			kind: "search",
			title: stripTags(match[2]),
			url,
			snippet: stripTags(match[3]),
			query,
		});
		if (results.length >= maxResults) break;
	}

	return results;
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const target = normalizeUrl(url);
	const response = await fetch(target, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5",
			"accept-language": "en-US,en;q=0.9",
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Fetch request failed with ${response.status}`);
	}

	const finalUrl = response.url || target;
	const body = await response.text();
	const contentType = response.headers.get("content-type") || "";
	const looksLikeHtml = contentType.includes("html") || /<html[\s>]/i.test(body);

	if (!looksLikeHtml) {
		const text = truncate(body.replace(/\s+/g, " ").trim(), MAX_FETCH_CHARS);
		return {
			kind: "fetch",
			title: finalUrl,
			url: finalUrl,
			excerpt: text,
		};
	}

	const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1] ? stripTags(titleMatch[1]) : finalUrl;
	const description = extractMetaDescription(body);
	const excerpt = truncate(htmlToText(body), MAX_FETCH_CHARS);

	return {
		kind: "fetch",
		title,
		url: finalUrl,
		description,
		excerpt,
	};
}

function renderSearchResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No search results found for "${query}".`;
	}

	return [
		`Web search results for "${query}":`,
		"",
		...results.flatMap((result, index) => [
			`${index + 1}. ${result.title}`,
			`URL: ${result.url}`,
			`Summary: ${result.snippet}`,
			"",
		]),
	]
		.join("\n")
		.trim();
}

function renderFetchedPage(result: FetchResult): string {
	const lines = [`Fetched ${result.url}`, `Title: ${result.title}`];
	if (result.description) lines.push(`Description: ${result.description}`);
	lines.push("", result.excerpt || "No readable text extracted.");
	return lines.join("\n");
}

export default function registerWebResearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_research",
		label: "Web Research",
		description:
			"Search the web and fetch external pages for official docs, API references, comparable products, market context, and current best practices.",
		promptSnippet: "Search the web and fetch external sources for docs, API research, and state-of-the-art comparisons.",
		promptGuidelines: [
			"Use web_research when external documentation or market context materially affects the plan.",
			"Prefer official docs and reputable primary sources before secondary commentary.",
			"Use action=search first, then action=fetch on the most relevant URLs to gather concrete details.",
		],
		parameters: WebResearchParams,

		async execute(_toolCallId, params, signal) {
			try {
				if (params.action === "search") {
					const query = params.query?.trim();
					if (!query) {
						return {
							content: [{ type: "text", text: "web_research search requires a query." }],
							details: {
								ok: false,
								action: "search",
								error: "Missing query",
								sources: [],
							} satisfies WebResearchDetails,
						};
					}

					const maxResults = Math.max(1, Math.min(8, Math.round(params.maxResults ?? 5)));
					const results = await searchWeb(query, maxResults, signal);
					return {
						content: [{ type: "text", text: renderSearchResults(query, results) }],
						details: {
							ok: true,
							action: "search",
							query,
							results,
							sources: results,
						} satisfies WebResearchDetails,
					};
				}

				const url = params.url?.trim();
				if (!url) {
					return {
						content: [{ type: "text", text: "web_research fetch requires a url." }],
						details: {
							ok: false,
							action: "fetch",
							error: "Missing url",
							sources: [],
						} satisfies WebResearchDetails,
					};
				}

				const fetched = await fetchPage(url, signal);
				return {
					content: [{ type: "text", text: renderFetchedPage(fetched) }],
					details: {
						ok: true,
						action: "fetch",
						url: fetched.url,
						fetched,
						sources: [fetched],
					} satisfies WebResearchDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Web research failed: ${message}` }],
					details: {
						ok: false,
						action: params.action,
						query: params.query,
						url: params.url,
						error: message,
						sources: [],
					} satisfies WebResearchDetails,
				};
			}
		},

		renderCall(args, theme) {
			const label = args.action === "search" ? args.query : args.url;
			return new Text(
				theme.fg("toolTitle", theme.bold("web_research ")) + theme.fg("muted", String(label ?? "")),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as WebResearchDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (!details.ok) {
				return new Text(theme.fg("warning", details.error || "Web research failed"), 0, 0);
			}

			if (details.action === "search") {
				return new Text(
					`${theme.fg("success", "✓ ")}${theme.fg("accent", details.results?.length?.toString() || "0")} result(s) for ${theme.fg("muted", details.query || "")}`,
					0,
					0,
				);
			}

			return new Text(
				`${theme.fg("success", "✓ ")}${theme.fg("accent", details.fetched?.title || details.url || "Fetched source")}`,
				0,
				0,
			);
		},
	});
}
