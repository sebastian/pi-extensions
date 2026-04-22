import test from "node:test";
import assert from "node:assert/strict";
import type { SubagentUsageTotals } from "../subagent-runner.ts";
import { buildUsageDisplay, formatTokens } from "../usage-display.ts";

function usage(overrides: Partial<SubagentUsageTotals> = {}): SubagentUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
		...overrides,
	};
}

test("formatTokens abbreviates the ranges used by footer and widget summaries", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(4500), "4.5k");
	assert.equal(formatTokens(12345), "12k");
	assert.equal(formatTokens(2500000), "2.5M");
});

test("buildUsageDisplay keeps footer totals aligned with widget totals and shows sub-agent cost explicitly", () => {
	const sessionUsage = usage({ input: 10000, output: 4500, cost: 0.078 });
	const subagentUsage = usage({ input: 2345, cacheRead: 900, cacheWrite: 50, cost: 0.045, turns: 2 });
	const totalUsage = usage({ input: 12345, output: 4500, cacheRead: 900, cacheWrite: 50, cost: 0.123, turns: 2 });

	const display = buildUsageDisplay({ sessionUsage, subagentUsage, totalUsage });

	assert.deepEqual(display.footerParts, ["↑12k", "↓4.5k", "R900", "W50", "$0.123 +subagents"]);
	assert.deepEqual(display.widgetLines, [
		"Cost ▸ total $0.123 • session $0.078 • subagents $0.045",
		"Tokens ▸ ↑12k • ↓4.5k • R900 • W50",
	]);
});

test("buildUsageDisplay keeps the widget cost line visible before any usage has accumulated", () => {
	const zero = usage();
	const display = buildUsageDisplay({
		sessionUsage: zero,
		subagentUsage: zero,
		totalUsage: zero,
	});

	assert.deepEqual(display.footerParts, []);
	assert.deepEqual(display.widgetLines, ["Cost ▸ total $0.000 • session $0.000"]);
});
