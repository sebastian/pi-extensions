import test from "node:test";
import assert from "node:assert/strict";
import {
	parseSelectedDiscrepancyIdsFromMarkdown,
	renderDiscrepancySelectionEditorMarkdown,
	selectRemainingActionableDiscrepancies,
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

test("renderDiscrepancySelectionEditorMarkdown preserves initial selections across repeated cycles", () => {
	const markdown = renderDiscrepancySelectionEditorMarkdown({
		title: "Select validator discrepancies to implement",
		actionableDiscrepancies: [
			discrepancy({ id: "D1", item: "Add validator tests" }),
			discrepancy({ id: "D2", item: "Update README", status: "partial" }),
		],
		initialSelectedIds: ["D2"],
	});

	assert.match(markdown, /- \[ \] `D1` — missing: Add validator tests/);
	assert.match(markdown, /- \[x\] `D2` — partial: Update README/);
});

test("custom selector returns back when Enter is pressed with no discrepancies selected", async () => {
	const result = await selectRemainingActionableDiscrepancies(
		{
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					let doneResult: unknown;
					const component = factory(
						{ requestRender: () => undefined },
						{ fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text, bold: (text: string) => text },
						undefined,
						(value: unknown) => {
							doneResult = value;
						},
					);
					component.handleInput("\t");
					component.handleInput("\r");
					return doneResult;
				},
			},
		} as any,
		{
			title: "Select validator discrepancies to implement",
			actionableDiscrepancies: [discrepancy({ id: "D1", item: "Add validator tests" })],
		},
	);

	assert.equal(result, undefined);
});

test("selector markdown uses stable fallback ids when discrepancies arrive without explicit ids", () => {
	const actionable: ValidationDiscrepancy[] = [
		discrepancy({ id: "", item: "Add validator tests" }),
		discrepancy({ id: "", item: "Update README", status: "partial" }),
	];
	const markdown = renderDiscrepancySelectionEditorMarkdown({
		title: "Select validator discrepancies to implement",
		actionableDiscrepancies: actionable,
		initialSelectedIds: ["discrepancy-update-readme"],
	});

	assert.match(markdown, /- \[ \] `discrepancy-add-validator-tests` — missing: Add validator tests/);
	assert.match(markdown, /- \[x\] `discrepancy-update-readme` — partial: Update README/);
	assert.deepEqual(
		parseSelectedDiscrepancyIdsFromMarkdown(
			[
				"- [x] `discrepancy-update-readme` — partial: Update README",
				"- [x] `discrepancy-add-validator-tests` — missing: Add validator tests",
			].join("\n"),
			actionable,
		),
		["discrepancy-add-validator-tests", "discrepancy-update-readme"],
	);
});
