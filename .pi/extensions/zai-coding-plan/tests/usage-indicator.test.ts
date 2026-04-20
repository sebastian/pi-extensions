import test from "node:test";
import assert from "node:assert/strict";
import {
	buildZaiUsageIndicatorLines,
	isZaiUsageModel,
	parseZaiQuotaSnapshot,
} from "../usage-indicator.ts";

const plainTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

test("isZaiUsageModel matches z.ai providers and hosts only", () => {
	assert.equal(isZaiUsageModel(undefined), false);
	assert.equal(isZaiUsageModel({ provider: "zai-coding-plan", baseUrl: "https://api.z.ai/api/coding/paas/v4" }), true);
	assert.equal(isZaiUsageModel({ provider: "custom", baseUrl: "https://api.z.ai/api/anthropic" }), true);
	assert.equal(isZaiUsageModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }), false);
});

test("parseZaiQuotaSnapshot extracts 5-hour and 7-day limits and ignores monthly MCP entries", () => {
	const snapshot = parseZaiQuotaSnapshot({
		data: {
			limits: [
				{ type: "TOKENS_LIMIT", percentage: 0.35, currentValue: 35, usage: 100 },
				{ type: "WEEKLY_LIMIT", percentage: 62, name: "7 Day quota" },
				{ type: "TIME_LIMIT", percentage: 12, title: "MCP usage (1 Month)" },
			],
		},
	});

	assert.equal(snapshot.limits.length, 2);
	assert.equal(snapshot.fiveHour?.remainingPercent, 65);
	assert.equal(snapshot.sevenDay?.remainingPercent, 38);
});

test("parseZaiQuotaSnapshot derives percentages from current and total values when needed", () => {
	const snapshot = parseZaiQuotaSnapshot({
		data: {
			limits: [
				{ type: "TOKENS_LIMIT", currentValue: 30, usage: 100 },
				{ type: "PLAN_LIMIT", title: "7 Day Limit", currentValue: 140, usage: 400 },
			],
		},
	});

	assert.equal(snapshot.fiveHour?.usedPercent, 30);
	assert.equal(snapshot.fiveHour?.remainingPercent, 70);
	assert.equal(snapshot.sevenDay?.usedPercent, 35);
	assert.equal(snapshot.sevenDay?.remainingPercent, 65);
});

test("parseZaiQuotaSnapshot recognizes live token windows by unit and reset horizon", () => {
	const fetchedAt = Date.parse("2026-04-20T08:00:00.000Z");
	const snapshot = parseZaiQuotaSnapshot(
		{
			code: 200,
			msg: "Operation successful",
			success: true,
			data: {
				limits: [
					{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 0, remaining: 100, percentage: 0, nextResetTime: 1779263229994 },
					{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: 1776690334718 },
					{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 4, nextResetTime: 1777276029997 },
				],
			},
		},
		fetchedAt,
	);

	assert.equal(snapshot.fiveHour?.kind, "5h");
	assert.equal(snapshot.fiveHour?.remainingPercent, 80);
	assert.equal(snapshot.sevenDay?.kind, "7d");
	assert.equal(snapshot.sevenDay?.remainingPercent, 96);
	assert.equal(snapshot.limits.length, 2);
});

test("buildZaiUsageIndicatorLines renders a compact live status line", () => {
	const snapshot = parseZaiQuotaSnapshot(
		{
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", percentage: 45 },
					{ type: "WEEKLY_LIMIT", percentage: 70 },
				],
			},
		},
		1000,
	);

	const lines = buildZaiUsageIndicatorLines({ snapshot, loading: false, error: null }, plainTheme, 1000);
	assert.deepEqual(lines, ["● z.ai 5h 55% · 7d 30%"]);
});

test("buildZaiUsageIndicatorLines keeps last snapshot visible but marks it stale on errors", () => {
	const snapshot = parseZaiQuotaSnapshot(
		{
			data: {
				limits: [{ type: "TOKENS_LIMIT", percentage: 25 }],
			},
		},
		1000,
	);

	const lines = buildZaiUsageIndicatorLines({ snapshot, loading: false, error: "request failed" }, plainTheme, 2000);
	assert.deepEqual(lines, ["◐ z.ai 5h 75% · stale"]);
});
