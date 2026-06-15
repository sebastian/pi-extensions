import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectChangedFiles,
	normalizeRepoRelativePath,
	parseGitDiffNameOnly,
	parseJjDiffSummary,
	pathsOverlap,
} from "../changes.ts";

test("parseJjDiffSummary handles adds, modifications, and renames", () => {
	const output = ["A README.md", "M src/index.ts", "R old/name.ts => new/name.ts"].join("\n");
	assert.deepEqual(parseJjDiffSummary(output), ["README.md", "new/name.ts", "old/name.ts", "src/index.ts"]);
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