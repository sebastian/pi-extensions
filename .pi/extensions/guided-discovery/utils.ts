import { createHash } from "node:crypto";

export interface ResearchSource {
	title: string;
	url: string;
	kind: "search" | "fetch";
	query?: string;
	snippet?: string;
}

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|grep|blame)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|why|audit|view)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

const FINAL_PLAN_SECTION_FORMATS = [
	[
		/^## Problem$/im,
		/^## Key findings$/im,
		/^## Options and trade-offs$/im,
		/^## Recommended approach$/im,
		/^## Build plan$/im,
		/^## Acceptance checks$/im,
		/^## Risks \/ follow-ups$/im,
	],
	[
		/^## Problem$/im,
		/^## What I learned$/im,
		/^## Decision log$/im,
		/^## Recommended approach$/im,
		/^## Implementation plan$/im,
		/^## Acceptance criteria$/im,
		/^## Risks \/ follow-ups$/im,
	],
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !isDestructive && isSafe;
}

export function isFinalPlanResponse(text: string): boolean {
	const normalized = text.trim();
	return normalized.length > 0 && FINAL_PLAN_SECTION_FORMATS.some((format) => format.every((pattern) => pattern.test(normalized)));
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function mergeResearchSources(current: ResearchSource[], incoming: ResearchSource[]): ResearchSource[] {
	const merged = new Map<string, ResearchSource>();
	for (const source of [...current, ...incoming]) {
		if (!source?.url) continue;
		merged.set(source.url, source);
	}
	return Array.from(merged.values());
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/[\[\]]/g, "\\$&");
}

export function renderPlanDocument(planText: string, sources: ResearchSource[]): string {
	const lines = [`<!-- Generated automatically by guided-discovery on ${new Date().toISOString()} -->`, "", planText.trim()];
	const dedupedSources = mergeResearchSources([], sources);

	if (dedupedSources.length > 0 && !/^## Sources consulted$/im.test(planText)) {
		lines.push("", "## Sources consulted", "");
		for (const source of dedupedSources) {
			const title = escapeMarkdownLinkText(source.title?.trim() || source.url);
			const qualifiers: string[] = [];
			if (source.kind === "search" && source.query) qualifiers.push(`query: ${source.query}`);
			if (source.snippet) qualifiers.push(truncate(source.snippet, 180));
			const suffix = qualifiers.length > 0 ? ` — ${qualifiers.join(" • ")}` : "";
			lines.push(`- [${title}](${source.url})${suffix}`);
		}
	}

	return `${lines.join("\n").trim()}\n`;
}
