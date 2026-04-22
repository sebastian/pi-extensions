import type { SubagentUsageTotals } from "./subagent-runner.ts";

export type ReviewModelState = "queued" | "running" | "done" | "error";

export interface ReviewModelProgress {
	model: string;
	state: ReviewModelState;
	currentTool?: string;
	latestActivity?: string;
	latestOutput?: string;
	error?: string;
	findings?: number;
	overallAssessment?: string;
	usage: SubagentUsageTotals;
}

export interface ReviewProgressSnapshot {
	targetLabel: string;
	implementationModel?: string;
	reviewerModels: string[];
	startedAt: number;
	models: ReviewModelProgress[];
}

const MAX_SNIPPET_LENGTH = 140;

export function compactReviewText(text: string, maxLength = MAX_SNIPPET_LENGTH): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function appendBoundedReviewText(existing: string | undefined, chunk: string, maxLength = 800): string {
	const next = `${existing ?? ""}${chunk}`;
	if (next.length <= maxLength) return next;
	return next.slice(next.length - maxLength);
}

export function createEmptyReviewUsageTotals(): SubagentUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

export function addReviewUsageTotals(total: SubagentUsageTotals, delta: SubagentUsageTotals): SubagentUsageTotals {
	return {
		input: total.input + delta.input,
		output: total.output + delta.output,
		cacheRead: total.cacheRead + delta.cacheRead,
		cacheWrite: total.cacheWrite + delta.cacheWrite,
		totalTokens: total.totalTokens + delta.totalTokens,
		cost: total.cost + delta.cost,
		turns: total.turns + delta.turns,
	};
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M tok`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok`;
	return `${tokens} tok`;
}

function formatElapsed(startedAt: number, now = Date.now()): string {
	const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatReviewUsageSummary(usage: SubagentUsageTotals): string | undefined {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.totalTokens > 0) parts.push(formatTokenCount(usage.totalTokens));
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(2)}`);
	return parts.length > 0 ? parts.join(" • ") : undefined;
}

function summarizeShellLikeCommand(command: string, maxLength = 80): string {
	return compactReviewText(command, maxLength);
}

export function summarizeReviewTool(toolName: string | undefined, args: unknown): string | undefined {
	if (!toolName) return undefined;
	if (!args || typeof args !== "object" || Array.isArray(args)) return toolName;
	const record = args as Record<string, unknown>;
	const path = typeof record.path === "string" ? record.path : undefined;
	const command = typeof record.command === "string" ? record.command : undefined;
	const pattern = typeof record.pattern === "string" ? record.pattern : undefined;
	const query = typeof record.query === "string" ? record.query : undefined;
	const files = Array.isArray(record.files) ? record.files.filter((value): value is string => typeof value === "string") : [];

	if (toolName === "read" && path) return `read ${path}`;
	if (toolName === "find" && pattern) return `find ${pattern}`;
	if (toolName === "grep" && pattern) return `grep ${pattern}`;
	if (toolName === "bash" && command) return `bash ${summarizeShellLikeCommand(command)}`;
	if (toolName === "ls" && path) return `ls ${path}`;
	if (toolName === "write" && path) return `write ${path}`;
	if (toolName === "edit" && path) return `edit ${path}`;
	if (query) return `${toolName} ${compactReviewText(query, 60)}`;
	if (files.length > 0) return `${toolName} ${compactReviewText(files[0]!, 60)}`;
	return toolName;
}

function stateGlyph(state: ReviewModelState): string {
	switch (state) {
		case "running":
			return "◉";
		case "done":
			return "✓";
		case "error":
			return "✕";
		default:
			return "○";
	}
}

function describeModelState(model: ReviewModelProgress): string {
	const parts: string[] = [model.state];
	if (typeof model.findings === "number") parts.push(`${model.findings} finding${model.findings === 1 ? "" : "s"}`);
	const usage = formatReviewUsageSummary(model.usage);
	if (usage) parts.push(usage);
	return parts.join(" • ");
}

export function summarizeReviewActivity(model: ReviewModelProgress): string | undefined {
	if (model.state === "error") return model.error ? `failed: ${compactReviewText(model.error, 90)}` : "failed";
	if (model.state === "done") {
		if (model.overallAssessment) return compactReviewText(model.overallAssessment, 90);
		if (typeof model.findings === "number") return `completed with ${model.findings} finding${model.findings === 1 ? "" : "s"}`;
		return "completed";
	}
	if (model.latestActivity) return compactReviewText(model.latestActivity, 90);
	if (model.currentTool) return `working with ${model.currentTool}`;
	if (model.state === "running") return "reviewing the change";
	return "queued";
}

export function formatReviewProgressLines(snapshot: ReviewProgressSnapshot, now = Date.now()): string[] {
	const completed = snapshot.models.filter((model) => model.state === "done" || model.state === "error").length;
	const total = snapshot.models.length;
	const lines = [
		`Scope: ${snapshot.targetLabel}`,
		`Implementation: ${snapshot.implementationModel ?? "unknown"}`,
		`Progress: ${completed}/${total} reviewer${total === 1 ? "" : "s"} finished • elapsed ${formatElapsed(snapshot.startedAt, now)}`,
		"",
	];

	for (const model of snapshot.models) {
		lines.push(`${stateGlyph(model.state)} ${model.model} — ${describeModelState(model)}`);
		const activity = summarizeReviewActivity(model);
		if (activity) lines.push(`  Reasoning: ${activity}`);
		if (model.currentTool) lines.push(`  Tool: ${compactReviewText(model.currentTool, 100)}`);
		if (model.latestOutput) lines.push(`  Output: ${compactReviewText(model.latestOutput, 110)}`);
		if (model.error && model.state !== "error") lines.push(`  Note: ${compactReviewText(model.error, 110)}`);
		lines.push("");
	}

	return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}
