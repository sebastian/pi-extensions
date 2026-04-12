import test from "node:test";
import assert from "node:assert/strict";
import { isFinalPlanResponse } from "../utils.ts";

test("isFinalPlanResponse accepts the concise discovery plan format", () => {
	const plan = [
		"## Problem",
		"",
		"Build a bounded discovery workflow.",
		"",
		"## Key findings",
		"",
		"- The current endgame is too heavy.",
		"",
		"## Options and trade-offs",
		"",
		"- Keep validator loops vs report gaps once.",
		"",
		"## Recommended approach",
		"",
		"Use a single advisory validator pass.",
		"",
		"## Build plan",
		"",
		"1. Simplify the workflow.",
		"",
		"## Acceptance checks",
		"",
		"- Final review stays bounded.",
		"",
		"## Risks / follow-ups",
		"",
		"- Coverage gaps may remain and should be reported clearly.",
	].join("\n");

	assert.equal(isFinalPlanResponse(plan), true);
});

test("isFinalPlanResponse still accepts the legacy discovery plan format", () => {
	const plan = [
		"## Problem",
		"",
		"Keep backwards compatibility.",
		"",
		"## What I learned",
		"",
		"- Existing saved plans use the legacy headings.",
		"",
		"## Decision log",
		"",
		"- Support both formats.",
		"",
		"## Recommended approach",
		"",
		"Accept both plan layouts.",
		"",
		"## Implementation plan",
		"",
		"1. Update final-plan detection.",
		"",
		"## Acceptance criteria",
		"",
		"- Legacy plans still auto-save.",
		"",
		"## Risks / follow-ups",
		"",
		"- None.",
	].join("\n");

	assert.equal(isFinalPlanResponse(plan), true);
});
