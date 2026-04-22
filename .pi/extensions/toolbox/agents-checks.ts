import type { CheckerFinding, CheckerReport } from "./structured-output.ts";
import type { ExecLike } from "./changes.ts";
import type { RelevantGuidanceDocument } from "./guidance.ts";

export interface AgentsCheckCommand {
	command: string;
	source: string;
}

export interface AgentsCheckExecutionPolicy {
	allowed: boolean;
	reason?: string;
}

export interface AgentsCheckRun {
	command: string;
	source: string;
	status: "passed" | "failed" | "blocked" | "error";
	summary: string;
	stdout: string;
	stderr: string;
	code: number | null;
}

const CHECK_HEADING_PATTERN = /^(#{1,6})\s*(checks?|validation|verify|verification|testing|tests|before finishing|before completion|before merging|done when)\b/i;
const EXPLICIT_COMMAND_PATTERN = /^\s*(?:[-*+]\s+|\d+\.\s+)?(?:run|command|check|verify|test)\s*:\s*`?([^`]+?)`?\s*$/i;
const SHELL_FENCE_PATTERN = /^```(?:sh|bash|zsh|shell)\s*$/i;
const FENCE_PATTERN = /^```/;
const FENCED_COMMENT_PATTERN = /^\s*#/;
const DISALLOWED_SHELL_SYNTAX_PATTERN = /[|&;<>`$()]/;
const KNOWN_CHECK_COMMAND_PATTERN = /^(npm|pnpm|yarn|bun|node|deno|python|python3|pytest|mypy|cargo|go|make|just|jj|git|uv|uvx|poetry|pip|npx|tsx|tsc|vitest|jest|mocha|ruff|eslint|prettier|biome|turbo|nx|gradle|mvn|dotnet|swift|xcodebuild|dart|flutter|phpunit|composer|bundle|rspec|mix|zig|cmake|ctest|bash|sh|zsh|shellcheck|yamllint|echo)\b/i;
const PATH_LIKE_COMMAND_PATTERN = /^(?:\.\.?\/|\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-][A-Za-z0-9_./-]*)/;
const SCRIPT_FILE_COMMAND_PATTERN = /^[A-Za-z0-9_.-]+\.(?:sh|bash|zsh|fish|ps1|cmd|bat|py|js|mjs|cjs|ts|mts|cts|rb|pl|php)$/i;

function trimBlock(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function firstCommandToken(value: string): string {
	return normalizeCommand(value).trim().split(/\s+/u, 1)[0] ?? "";
}

function isLikelyRunnableCommand(value: string): boolean {
	const command = normalizeCommand(value);
	if (!command) return false;
	if (command.includes("\n")) return false;
	if (/^[A-Z][A-Z0-9_]+\s*:/.test(command)) return false;
	if (/^(yes|no|true|false)$/i.test(command)) return false;
	const firstToken = firstCommandToken(command);
	if (!firstToken) return false;
	return (
		KNOWN_CHECK_COMMAND_PATTERN.test(firstToken) ||
		PATH_LIKE_COMMAND_PATTERN.test(firstToken) ||
		SCRIPT_FILE_COMMAND_PATTERN.test(firstToken)
	);
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/^`|`$/g, "");
}

function commandDedupeKey(command: string): string {
	return normalizeCommand(command).replace(/\s+/g, " ");
}

function dedupeCommands(commands: AgentsCheckCommand[]): AgentsCheckCommand[] {
	const deduped = new Map<string, AgentsCheckCommand & { sources: string[] }>();
	for (const command of commands) {
		const normalizedCommand = commandDedupeKey(command.command);
		const existing = deduped.get(normalizedCommand);
		if (!existing) {
			deduped.set(normalizedCommand, {
				command: normalizeCommand(command.command),
				source: command.source,
				sources: [command.source],
			});
			continue;
		}
		if (!existing.sources.includes(command.source)) existing.sources.push(command.source);
		existing.source = existing.sources.join(", ");
	}
	return Array.from(deduped.values()).map(({ command, source }) => ({ command, source }));
}

function summarizeOutput(stdout: string, stderr: string, code: number | null): string {
	const text = [stderr, stdout]
		.join("\n")
		.split(/\r?\n/u)
		.map((line) => trimBlock(line))
		.find(Boolean);
	if (text) return text;
	if (typeof code === "number") return `Exited with code ${code}`;
	return "No output captured.";
}

function parseExecTokens(command: string): string[] | null {
	const trimmed = normalizeCommand(command);
	if (!trimmed || trimmed.includes("\n") || DISALLOWED_SHELL_SYNTAX_PATTERN.test(trimmed)) return null;

	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;

	const pushCurrent = (): void => {
		if (!current) return;
		tokens.push(current);
		current = "";
	};

	for (const char of trimmed) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			pushCurrent();
			continue;
		}
		current += char;
	}

	if (escaping || quote) return null;
	pushCurrent();
	if (tokens.length === 0) return null;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) return null;
	return tokens;
}

export function extractAgentsCheckCommands(markdown: string, source: string): AgentsCheckCommand[] {
	const commands: AgentsCheckCommand[] = [];
	const lines = markdown.split(/\r?\n/u);
	let inRelevantSection = false;
	let inRelevantFence = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;

		if (SHELL_FENCE_PATTERN.test(line)) {
			inRelevantFence = inRelevantSection;
			continue;
		}
		if (FENCE_PATTERN.test(line)) {
			inRelevantFence = false;
			continue;
		}
		if (!inRelevantFence && /^#{1,6}\s+/.test(line)) {
			inRelevantSection = CHECK_HEADING_PATTERN.test(line);
			continue;
		}

		const explicit = line.match(EXPLICIT_COMMAND_PATTERN)?.[1];
		if (explicit) {
			const command = normalizeCommand(explicit);
			if (isLikelyRunnableCommand(command)) commands.push({ command, source });
			continue;
		}

		if (!inRelevantFence || !inRelevantSection || FENCED_COMMENT_PATTERN.test(line)) continue;
		const command = normalizeCommand(line);
		if (isLikelyRunnableCommand(command)) commands.push({ command, source });
	}

	return dedupeCommands(commands);
}

export function collectAgentsCheckCommands(documents: RelevantGuidanceDocument[]): AgentsCheckCommand[] {
	return dedupeCommands(
		documents.flatMap((document) => extractAgentsCheckCommands(document.content, document.relativePath)),
	);
}

export async function runAgentsCheckCommands(options: {
	cwd: string;
	exec: ExecLike;
	commands: AgentsCheckCommand[];
	policy?: AgentsCheckExecutionPolicy;
	timeoutMs?: number;
}): Promise<AgentsCheckRun[]> {
	const runs: AgentsCheckRun[] = [];
	const policy = options.policy ?? { allowed: true };
	for (const command of options.commands) {
		if (!policy.allowed) {
			runs.push({
				command: command.command,
				source: command.source,
				status: "blocked",
				summary: policy.reason || "AGENTS.md command execution was not approved for this workflow.",
				stdout: "",
				stderr: "",
				code: null,
			});
			continue;
		}

		const execTokens = parseExecTokens(command.command);
		if (!execTokens) {
			runs.push({
				command: command.command,
				source: command.source,
				status: "blocked",
				summary:
					"Only simple argv-style commands are allowed. Remove shell operators or environment assignments from AGENTS.md.",
				stdout: "",
				stderr: "",
				code: null,
			});
			continue;
		}
		try {
			const result = await options.exec(execTokens[0]!, execTokens.slice(1), {
				cwd: options.cwd,
				timeout: options.timeoutMs ?? 300_000,
			});
			runs.push({
				command: command.command,
				source: command.source,
				status: result.code === 0 ? "passed" : "failed",
				summary: summarizeOutput(result.stdout, result.stderr, result.code),
				stdout: result.stdout,
				stderr: result.stderr,
				code: result.code,
			});
		} catch (error) {
			runs.push({
				command: command.command,
				source: command.source,
				status: "error",
				summary: error instanceof Error ? error.message : String(error),
				stdout: "",
				stderr: "",
				code: null,
			});
		}
	}
	return runs;
}

export function buildAgentsCheckFindings(runs: AgentsCheckRun[]): CheckerFinding[] {
	return runs
		.filter((run) => run.status === "failed" || run.status === "error" || run.status === "blocked")
		.map((run, index) => ({
			id: `agents-check-${index + 1}`,
			category: "guidance",
			severity: "high",
			summary:
				run.status === "failed"
					? `Required AGENTS.md check failed: ${run.command}`
					: run.status === "error"
						? `Required AGENTS.md check errored: ${run.command}`
						: `Required AGENTS.md check was blocked: ${run.command}`,
			details: `${run.source}: ${run.summary}`,
			suggestedFix:
				run.status === "failed"
					? `Make the implementation pass \`${run.command}\` as requested by ${run.source}.`
					: run.status === "error"
						? `Fix the command or environment so \`${run.command}\` can run successfully as requested by ${run.source}.`
						: `Approve or simplify \`${run.command}\` so the AGENTS.md-required check can actually run for ${run.source}.`,
			paths: [],
		} satisfies CheckerFinding));
}

function buildBlockedAgentsCheckRisks(runs: AgentsCheckRun[]): string[] {
	return runs
		.filter((run) => run.status === "blocked")
		.map((run) => `AGENTS.md requested check was not executed: ${run.command} (${run.source}) — ${run.summary}`);
}

export function appendAgentsChecksToCheckerReport(report: CheckerReport, runs: AgentsCheckRun[]): CheckerReport {
	return {
		...report,
		findings: [...report.findings, ...buildAgentsCheckFindings(runs)],
		checksRun: [
			...report.checksRun,
			...runs.map((run) => ({
				command: run.command,
				source: run.source,
				status: run.status,
				summary: run.summary,
			})),
		],
		unresolvedRisks: [...new Set([...report.unresolvedRisks, ...buildBlockedAgentsCheckRisks(runs)])],
	};
}
