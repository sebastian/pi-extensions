import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAncestorDocumentPaths, discoverRelevantGuidance, renderGuidanceSummary } from "../guidance.ts";

test("discoverAncestorDocumentPaths returns existing AGENTS files from root to leaf", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-guidance-"));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src", "feature"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root guidance", "utf8");
	await writeFile(join(root, "src", "AGENTS.md"), "src guidance", "utf8");

	const paths = discoverAncestorDocumentPaths(join(root, "src", "feature"), root, "AGENTS.md");
	assert.deepEqual(paths, [join(root, "AGENTS.md"), join(root, "src", "AGENTS.md")]);
});

test("discoverRelevantGuidance walks changed-file ancestors up to repo root", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-guidance-"));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src", "feature"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root guidance", "utf8");
	await writeFile(join(root, "src", "AGENTS.md"), "src guidance", "utf8");

	const result = discoverRelevantGuidance(root, ["src/feature/index.ts"]);
	assert.equal(result.documents.length, 2);
	assert.deepEqual(
		result.documents.map((document) => ({ path: document.relativePath, appliesTo: document.appliesTo })),
		[
			{ path: "AGENTS.md", appliesTo: ["src/feature/index.ts"] },
			{ path: "src/AGENTS.md", appliesTo: ["src/feature/index.ts"] },
		],
	);
});

test("discoverRelevantGuidance also handles directory touched paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-guidance-"));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src", "feature"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root guidance", "utf8");
	await writeFile(join(root, "src", "AGENTS.md"), "src guidance", "utf8");

	const result = discoverRelevantGuidance(root, ["src"]);
	assert.equal(result.documents.length, 2);
	assert.deepEqual(
		result.documents.map((document) => ({ path: document.relativePath, appliesTo: document.appliesTo })),
		[
			{ path: "AGENTS.md", appliesTo: ["src"] },
			{ path: "src/AGENTS.md", appliesTo: ["src"] },
		],
	);
});

test("renderGuidanceSummary lists applicable AGENTS files", () => {
	const summary = renderGuidanceSummary(
		{
			repoRoot: "/repo",
			documents: [
				{
					path: "/repo/AGENTS.md",
					relativePath: "AGENTS.md",
					content: "guidance",
					appliesTo: ["src/index.ts"],
				},
			],
		},
		"AGENTS.md",
	);
	assert.match(summary, /AGENTS\.md/);
	assert.match(summary, /src\/index\.ts/);
});
