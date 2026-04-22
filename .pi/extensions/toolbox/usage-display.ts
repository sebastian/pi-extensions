import type { SubagentUsageTotals } from "./subagent-runner.ts";

export interface UsageDisplayInput {
	sessionUsage: SubagentUsageTotals;
	subagentUsage: SubagentUsageTotals;
	totalUsage: SubagentUsageTotals;
}

export interface UsageDisplaySummary {
	footerParts: string[];
	widgetLines: string[];
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return (count / 1000).toFixed(1) + "k";
	if (count < 1000000) return Math.round(count / 1000) + "k";
	if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
	return Math.round(count / 1000000) + "M";
}

export function hasUsageTotals(usage: SubagentUsageTotals): boolean {
	return Boolean(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost || usage.turns);
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(3)}`;
}

function buildTokenParts(usage: SubagentUsageTotals): string[] {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	return parts;
}

export function buildUsageDisplay({ sessionUsage, subagentUsage, totalUsage }: UsageDisplayInput): UsageDisplaySummary {
	const hasSubagentUsage = hasUsageTotals(subagentUsage);
	const footerParts = buildTokenParts(totalUsage);
	if (totalUsage.cost || hasSubagentUsage) {
		footerParts.push(`${formatCost(totalUsage.cost)}${hasSubagentUsage ? " +subagents" : ""}`);
	}

	const widgetCostParts = [`total ${formatCost(totalUsage.cost)}`, `session ${formatCost(sessionUsage.cost)}`];
	if (hasSubagentUsage) widgetCostParts.push(`subagents ${formatCost(subagentUsage.cost)}`);

	const widgetLines = [`Cost ▸ ${widgetCostParts.join(" • ")}`];
	const tokenParts = buildTokenParts(totalUsage);
	if (tokenParts.length > 0) widgetLines.push(`Tokens ▸ ${tokenParts.join(" • ")}`);

	return { footerParts, widgetLines };
}
