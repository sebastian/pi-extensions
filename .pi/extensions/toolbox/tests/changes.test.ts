import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeExecutionBatches,
	detectChangedFiles,
	normalizeRepoRelativePath,
	parseGitDiffNameOnly,
	parseJjDiffSummary,
	pathsOverlap,
} from "../changes.ts";
import type { DecompositionPhase } from "../structured-output.ts";

test("parseJjDiffSummary handles adds, modifications, and renames", () => {
	const output = ["A PLAN.md", "M src/index.ts", "R old/name.ts => new/name.ts"].join("\n");
	assert.deepEqual(parseJjDiffSummary(output), ["PLAN.md", "new/name.ts", "old/name.ts", "src/index.ts"]);
});

test("parseGitDiffNameOnly normalizes and deduplicates paths", () => {
	const output = ["./src/index.ts", "src/index.ts", "docs/README.md"].join("\n");
	assert.deepEqual(parseGitDiffNameOnly(output), ["docs/README.md", "src/index.ts"]);
});

test("normalizeRepoRelativePath rejects absolute and escaping paths", () => {
	assert.equal(normalizeRepoRelativePath("/tmp/outside"), null);
	assert.equal(normalizeRepoRelativePath("../outside"), null);
	assert.equal(normalizeRepoRelativePath("src/../../outside"), null);
	assert.equal(normalizeRepoRelativePath("./src/index.ts"), "src/index.ts");
});

test("pathsOverlap is conservative for empty and broad scopes", () => {
	assert.equal(pathsOverlap([], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src"], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src/*.ts"], ["src/index.ts"]), true);
	assert.equal(pathsOverlap(["src/index.ts"], ["docs/README.md"]), false);
});

test("detectChangedFiles includes untracked git files", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-changes-"));
	await mkdir(join(root, ".git"));

	const changed = await detectChangedFiles(root, async (command, args) => {
		if (command !== "git") return { stdout: "", stderr: "", code: 1 };
		if (args.join(" ") === "diff --name-only --relative") {
			return { stdout: "src/index.ts\n", stderr: "", code: 0 };
		}
		if (args.join(" ") === "ls-files --others --exclude-standard") {
			return { stdout: "src/new.ts\n", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 1 };
	});

	assert.deepEqual(changed, ["src/index.ts", "src/new.ts"]);
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
			designSensitive: false,
		},
		{
			id: "phase-2",
			title: "Update tests",
			goal: "Tests",
			instructions: ["Edit tests"],
			dependsOn: [],
			touchedPaths: ["tests"],
			parallelSafe: true,
			designSensitive: false,
		},
		{
			id: "phase-3",
			title: "Touch docs again",
			goal: "More docs",
			instructions: ["Edit docs again"],
			dependsOn: [],
			touchedPaths: ["docs/README.md"],
			parallelSafe: true,
			designSensitive: false,
		},
	];

	const batches = computeExecutionBatches(phases);
	assert.deepEqual(
		batches.map((batch) => batch.map((phase) => phase.id)),
		[["phase-1", "phase-2"], ["phase-3"]],
	);
});
