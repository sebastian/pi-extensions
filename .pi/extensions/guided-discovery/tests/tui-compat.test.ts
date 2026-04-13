import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { createImplementationProgressState, reduceImplementationProgress } from "../implementation-progress.ts";
import { renderImplementationProgressWidget } from "../implementation-progress-widget.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "../tui-compat.ts";

test("visibleWidth and truncateToWidth treat ANSI styling as zero-width", () => {
	const styled = "\u001b[36mhello\u001b[0m";
	assert.equal(visibleWidth(styled), 5);
	assert.equal(visibleWidth(truncateToWidth(styled, 4)), 4);
	assert.equal(visibleWidth(padToWidth(styled, 8)), 8);
});

test("implementation progress widget keeps framed lines aligned when the theme emits ANSI styling", () => {
	const theme = {
		fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
	} as const;

	let state = createImplementationProgressState({
		detailLines: [
			"Breaking the approved plan into implementation phases...",
			"Primary model: openai-codex/gpt-5.4",
		],
	});
	state = reduceImplementationProgress(state, { type: "decomposer-started" });

	const width = 80;
	const lines = renderImplementationProgressWidget(theme as Theme, state, width, {
		usageSummaryLines: [
			"Cost ▸ total $0.123 • session $0.078 • subagents $0.045",
			"Tokens ▸ ↑12k • ↓4.5k • R900 • W50",
		],
	});
	assert.ok(lines.length > 3);
	for (const line of lines) {
		assert.equal(visibleWidth(line), width);
	}
});
