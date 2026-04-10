import test from "node:test";
import assert from "node:assert/strict";
import { computeExecutionBatches, parseGitDiffNameOnly, parseJjDiffSummary, pathsOverlap } from "../changes.ts";
import type { DecompositionPhase } from "../structured-output.ts";

test("parseJjDiffSummary handles adds, modifications, and renames", () => {
	const output = ["A PLAN.md", "M src/index.ts", "R old/name.ts => new/name.ts"].join("\n");
	assert.deepEqual(parseJjDiffSummary(output), ["PLAN.md", "new/name.ts", "old/name.ts", "src/index.ts"]);
});

test("parseGitDiffNameOnly normalizes and deduplicates paths", () => {
	const output = ["./src/index.ts", "src/index.ts", "docs/README.md"].join("\n");
	assert.deepEqual(parseGitDiffNameOnly(output), ["docs/README.md", "src/index.ts"]);
});

test("pathsOverlap is conservative for empty and broad scopes", () => {
	assert.equal(pathsOverlap([], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src"], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src/*.ts"], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src/index.ts"], ["docs/README.md"]), false);
});

test("computeExecutionBatches keeps overlapping phases sequential and independent phases parallel", () => {
	const phases: DecompositionPhase[] = [
		{
			id: "phase-1",
			title: "Update docs",
			goal: "Docs",
			instructions: ["Edit docs"],
			dependsOn: [],
			touchedPaths: ["docs"],
			parallelSafe: true,
		},
		{
			id: "phase-2",
			title: "Update tests",
			goal: "Tests",
			instructions: ["Edit tests"],
			dependsOn: [],
			touchedPaths: ["tests"],
			parallelSafe: true,
		},
		{
			id: "phase-3",
			title: "Touch docs again",
			goal: "More docs",
			instructions: ["Edit docs again"],
			dependsOn: [],
			touchedPaths: ["docs/README.md"],
			parallelSafe: true,
		},
	];

	const batches = computeExecutionBatches(phases);
	assert.deepEqual(
		batches.map((batch) => batch.map((phase) => phase.id)),
		[["phase-1", "phase-2"], ["phase-3"]],
	);
});
