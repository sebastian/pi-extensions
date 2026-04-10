import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ExecLike } from "./changes.ts";

export interface RelevantChecksDocument {
	path: string;
	relativePath: string;
	content: string;
	appliesTo: string[];
}

export interface RelevantChecksResult {
	repoRoot: string;
	documents: RelevantChecksDocument[];
	fileToChecks: Record<string, string[]>;
}

export interface SuggestedCheckCommand {
	command: string;
	sourcePath: string;
	relativeSourcePath: string;
	safe: boolean;
	reason?: string;
}

export interface CheckCommandResult {
	command: string;
	source: string;
	status: "passed" | "failed" | "blocked" | "error";
	summary: string;
}

const BLOCKED_PATTERNS = [
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
	/\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|update|upgrade|publish|link|create)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bjj\s+(new|commit|describe|bookmark|git\s+push|move|rebase|squash|abandon)\b/i,
	/\bdeploy\b/i,
	/\brelease\b/i,
	/\bpublish\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*(npm|pnpm)\s+test\b/i,
	/^\s*(npm|pnpm)\s+run\s+(test|lint|build|check|typecheck|verify|validate|e2e|unit|integration)\b/i,
	/^\s*yarn\s+(test|lint|build|check|typecheck|verify|validate|e2e|unit|integration)\b/i,
	/^\s*bun\s+(test|run\s+(test|lint|build|check|typecheck|verify|validate))\b/i,
	/^\s*node\s+--test\b/i,
	/^\s*(npx|pnpm\s+dlx)\s+(vitest|jest|playwright)\b/i,
	/^\s*(vitest|jest)\b/i,
	/^\s*playwright\s+test\b/i,
	/^\s*tsc\b(?:.*\s)?--noEmit\b/i,
	/^\s*eslint\b/i,
	/^\s*pytest\b/i,
	/^\s*(python\s+-m\s+pytest|python\s+-m\s+unittest|uv\s+run\s+pytest|poetry\s+run\s+pytest)\b/i,
	/^\s*(ruff\s+check|mypy)\b/i,
	/^\s*cargo\s+(test|check|clippy)\b/i,
	/^\s*go\s+(test|vet)\b/i,
	/^\s*deno\s+(test|check)\b/i,
	/^\s*swift\s+test\b/i,
	/^\s*(gradle|gradlew)\s+(test|check|build)\b/i,
	/^\s*xcodebuild\b.*\b(test|build)\b/i,
	/^\s*(ls|find|grep|rg|fd|cat|head|tail|sed\s+-n|awk|jq|sort|uniq|wc|pwd)\b/i,
];

function truncate(text: string, maxLength = 1200): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function findRepoRoot(start: string): string {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(start);
		current = parent;
	}
}

function fileExists(path: string): boolean {
	return existsSync(path);
}

export function discoverRelevantChecks(cwd: string, changedFiles: string[]): RelevantChecksResult {
	const repoRoot = findRepoRoot(cwd);
	const documents = new Map<string, RelevantChecksDocument>();
	const fileToChecks: Record<string, string[]> = {};

	for (const changedFile of changedFiles) {
		const absolutePath = resolve(repoRoot, changedFile);
		let currentDir = dirname(absolutePath);
		const discoveredForFile: string[] = [];

		while (true) {
			const candidate = join(currentDir, "CHECKS.md");
			if (fileExists(candidate)) {
				discoveredForFile.push(candidate);
				if (!documents.has(candidate)) {
					documents.set(candidate, {
						path: candidate,
						relativePath: relative(repoRoot, candidate).replace(/\\/g, "/"),
						content: readFileSync(candidate, "utf8"),
						appliesTo: [changedFile],
					});
				} else {
					const document = documents.get(candidate)!;
					if (!document.appliesTo.includes(changedFile)) document.appliesTo.push(changedFile);
				}
			}

			if (currentDir === repoRoot) break;
			const parent = dirname(currentDir);
			if (parent === currentDir) break;
			currentDir = parent;
		}

		fileToChecks[changedFile] = [...new Set(discoveredForFile.map((path) => relative(repoRoot, path).replace(/\\/g, "/")))];
	}

	return {
		repoRoot,
		documents: Array.from(documents.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
		fileToChecks,
	};
}

export function extractSuggestedCheckCommands(markdown: string): string[] {
	const commands: string[] = [];
	const fencedBlockPattern = /```(?:bash|sh|shell|zsh)?\s*([\s\S]*?)```/gi;

	for (const match of markdown.matchAll(fencedBlockPattern)) {
		const block = match[1] ?? "";
		for (const rawLine of block.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			commands.push(line.replace(/^\$\s*/, ""));
		}
	}

	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.includes("`") || !/(run|command|check|test|lint|build)/i.test(line)) continue;
		const inlineMatches = [...line.matchAll(/`([^`\n]+)`/g)];
		for (const inlineMatch of inlineMatches) {
			const command = inlineMatch[1]?.trim();
			if (command) commands.push(command);
		}
	}

	return [...new Set(commands)];
}

export function getCheckCommandSafety(command: string): { safe: boolean; reason?: string } {
	if (!command.trim()) return { safe: false, reason: "Empty command" };
	if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) {
		return { safe: false, reason: "Blocked by safety filter" };
	}
	if (SAFE_PATTERNS.some((pattern) => pattern.test(command))) {
		return { safe: true };
	}
	return { safe: false, reason: "Command is not on the verification allowlist" };
}

export function collectSuggestedCheckCommands(documents: RelevantChecksDocument[]): SuggestedCheckCommand[] {
	const commands: SuggestedCheckCommand[] = [];
	for (const document of documents) {
		for (const command of extractSuggestedCheckCommands(document.content)) {
			const safety = getCheckCommandSafety(command);
			commands.push({
				command,
				sourcePath: document.path,
				relativeSourcePath: document.relativePath,
				safe: safety.safe,
				reason: safety.reason,
			});
		}
	}
	return commands;
}

export async function runSafeCheckCommands(
	exec: ExecLike,
	cwd: string,
	commands: SuggestedCheckCommand[],
	timeout = 120_000,
): Promise<CheckCommandResult[]> {
	const results: CheckCommandResult[] = [];
	const seenCommands = new Set<string>();

	for (const command of commands) {
		if (seenCommands.has(command.command)) continue;
		seenCommands.add(command.command);

		if (!command.safe) {
			results.push({
				command: command.command,
				source: command.relativeSourcePath,
				status: "blocked",
				summary: command.reason ?? "Blocked by safety filter",
			});
			continue;
		}

		try {
			const result = await exec("bash", ["-lc", command.command], { cwd, timeout });
			const combinedOutput = truncate([result.stdout, result.stderr].filter(Boolean).join("\n"));
			results.push({
				command: command.command,
				source: command.relativeSourcePath,
				status: result.code === 0 ? "passed" : "failed",
				summary: combinedOutput || `Exited with code ${result.code}`,
			});
		} catch (error) {
			results.push({
				command: command.command,
				source: command.relativeSourcePath,
				status: "error",
				summary: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

export function renderChecksContext(
	relevantChecks: RelevantChecksResult,
	commands: SuggestedCheckCommand[],
	results: CheckCommandResult[],
): string {
	const lines: string[] = [];
	lines.push("## Relevant CHECKS.md documents", "");
	if (relevantChecks.documents.length === 0) {
		lines.push("None detected for the changed files.");
	} else {
		for (const document of relevantChecks.documents) {
			lines.push(`- ${document.relativePath} (applies to: ${document.appliesTo.join(", ")})`);
		}
	}

	lines.push("", "## Suggested check commands", "");
	if (commands.length === 0) {
		lines.push("No command suggestions were detected.");
	} else {
		for (const command of commands) {
			lines.push(
				`- ${command.command} [${command.safe ? "allowed" : `blocked: ${command.reason ?? "policy"}`}] from ${command.relativeSourcePath}`,
			);
		}
	}

	lines.push("", "## Executed check results", "");
	if (results.length === 0) {
		lines.push("No safe check commands were executed.");
	} else {
		for (const result of results) {
			lines.push(`- ${result.command} (${result.source}) => ${result.status}: ${result.summary}`);
		}
	}

	return `${lines.join("\n").trim()}\n`;
}
