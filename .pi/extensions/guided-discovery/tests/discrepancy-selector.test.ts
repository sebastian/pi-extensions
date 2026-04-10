import test from "node:test";
import assert from "node:assert/strict";
import {
	parseSelectedDiscrepancyIdsFromMarkdown,
	renderDiscrepancySelectionEditorMarkdown,
} from "../discrepancy-selector.ts";
import type { ValidationDiscrepancy } from "../structured-output.ts";

function discrepancy(overrides: Partial<ValidationDiscrepancy> = {}): ValidationDiscrepancy {
	const worthImplementingNow = overrides.worthImplementingNow ?? false;
	return {
		id: overrides.id ?? "discrepancy-1",
		item: overrides.item ?? "Add tests",
		status: overrides.status ?? "missing",
		reason: overrides.reason ?? "The first pass prioritized the main workflow.",
		suggestedAction: overrides.suggestedAction ?? "Implement the missing work.",
		worthImplementingNow,
		worthwhileRationale:
			overrides.worthwhileRationale ??
			(worthImplementingNow ? "Small and safe to land now." : "Worth doing later after the behavior settles."),
	};
}

test("renderDiscrepancySelectionEditorMarkdown renders keyed checklists and informational items", () => {
	const markdown = renderDiscrepancySelectionEditorMarkdown({
		title: "Select validator discrepancies to implement",
		actionableDiscrepancies: [
			discrepancy({ id: "D1", item: "Add validator tests", worthImplementingNow: true }),
			discrepancy({ id: "D2", item: "Update README", status: "partial" }),
		],
		informationalDiscrepancies: [
			discrepancy({
				id: "D3",
				item: "Retire obsolete prompt copy",
				status: "superseded",
				reason: "The older wording is no longer relevant after the new flow.",
				suggestedAction: "Leave it reported for context.",
			}),
		],
		introLines: ["Two actionable discrepancies remain."],
	});

	assert.match(markdown, /# Select validator discrepancies to implement/);
	assert.match(markdown, /Two actionable discrepancies remain\./);
	assert.match(markdown, /- \[ \] `D1` — missing: Add validator tests/);
	assert.match(markdown, /- \[ \] `D2` — partial: Update README/);
	assert.match(markdown, /worth implementing now: yes/);
	assert.match(markdown, /## Informational only \(not selectable\)/);
	assert.match(markdown, /- `D3` — superseded: Retire obsolete prompt copy/);
	assert.doesNotMatch(markdown, /\[ \] `D3`/);
});

test("parseSelectedDiscrepancyIdsFromMarkdown keeps actionable ids in workflow order", () => {
	const actionable = [
		discrepancy({ id: "D1", item: "Add validator tests" }),
		discrepancy({ id: "D2", item: "Update README", status: "partial" }),
		discrepancy({ id: "D3", item: "Tighten copy" }),
	];

	const selectedIds = parseSelectedDiscrepancyIdsFromMarkdown(
		[
			"- [x] `D2` — partial: Update README",
			"- [ ] `D1` — missing: Add validator tests",
			"- [x] `D3` — missing: Tighten copy",
			"- [x] `D9` — missing: Unknown item",
		].join("\n"),
		actionable,
	);

	assert.deepEqual(selectedIds, ["D2", "D3"]);
});

test("parseSelectedDiscrepancyIdsFromMarkdown accepts plain ids and ignores duplicates", () => {
	const actionable = [
		discrepancy({ id: "D1", item: "Add validator tests" }),
		discrepancy({ id: "D2", item: "Update README", status: "partial" }),
	];

	const selectedIds = parseSelectedDiscrepancyIdsFromMarkdown(
		[
			"1. [x] D2 keep this checked",
			"- [x] `D1` — missing: Add validator tests",
			"- [x] `D2` — partial: Update README",
			"- [x] `D2` — partial: Update README",
		].join("\n"),
		actionable,
	);

	assert.deepEqual(selectedIds, ["D1", "D2"]);
});
