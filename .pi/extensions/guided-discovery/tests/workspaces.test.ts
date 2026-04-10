import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSnapshot, detectWorkspaceRepoKind, planWorkspaceIntegration } from "../workspaces.ts";
import type { ExecLike } from "../changes.ts";

async function createRepoRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src"), { recursive: true });
	return root;
}

test("detectWorkspaceRepoKind prefers jj repositories", async () => {
	const root = await createRepoRoot("guided-discovery-workspaces-");
	assert.equal(detectWorkspaceRepoKind(root), "jj");
});

test("createWorkspaceSnapshot can capture the full working tree without VCS metadata", async () => {
	const root = await createRepoRoot("guided-discovery-workspaces-");
	await mkdir(join(root, ".git"));
	await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");
	await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

	const snapshot = await createWorkspaceSnapshot({
		cwd: root,
		touchedPaths: [],
		seededChangedFiles: [],
		includeAllFiles: true,
	});

	assert.deepEqual(Object.keys(snapshot.files), ["src/tracked.ts"]);
});

test("planWorkspaceIntegration separates non-conflicting and conflicting child changes", async () => {
	const parentRoot = await createRepoRoot("guided-discovery-parent-");
	const childRoot = await createRepoRoot("guided-discovery-child-");

	await writeFile(join(parentRoot, "src", "same.ts"), "baseline-same\n", "utf8");
	await writeFile(join(parentRoot, "src", "safe.ts"), "baseline-safe\n", "utf8");
	await writeFile(join(childRoot, "src", "same.ts"), "baseline-same\n", "utf8");
	await writeFile(join(childRoot, "src", "safe.ts"), "baseline-safe\n", "utf8");

	const baseline = await createWorkspaceSnapshot({
		cwd: childRoot,
		touchedPaths: ["src"],
		seededChangedFiles: [],
	});

	await writeFile(join(parentRoot, "src", "same.ts"), "parent-new\n", "utf8");
	await writeFile(join(childRoot, "src", "same.ts"), "child-new\n", "utf8");
	await writeFile(join(childRoot, "src", "safe.ts"), "child-safe\n", "utf8");
	await writeFile(join(childRoot, "src", "new.ts"), "brand new\n", "utf8");
	baseline.files["src/new.ts"] = null;

	const exec: ExecLike = async (_command, _args, options) => {
		if (options?.cwd?.startsWith(childRoot)) {
			return {
				stdout: ["M src/same.ts", "M src/safe.ts", "A src/new.ts"].join("\n"),
				stderr: "",
				code: 0,
			};
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const plan = await planWorkspaceIntegration({
		childCwd: childRoot,
		parentCwd: parentRoot,
		baseline,
		exec,
	});

	assert.deepEqual(plan.changedFiles, ["src/new.ts", "src/safe.ts", "src/same.ts"]);
	assert.deepEqual(plan.nonConflictingFiles, ["src/new.ts", "src/safe.ts"]);
	assert.deepEqual(plan.conflictingFiles, ["src/same.ts"]);
});

test("planWorkspaceIntegration treats unexpected edits to existing parent files as conflicts", async () => {
	const parentRoot = await createRepoRoot("guided-discovery-parent-");
	const childRoot = await createRepoRoot("guided-discovery-child-");

	await writeFile(join(parentRoot, "package.json"), "baseline\n", "utf8");
	await writeFile(join(childRoot, "package.json"), "baseline\n", "utf8");

	const baseline = await createWorkspaceSnapshot({
		cwd: childRoot,
		touchedPaths: ["src"],
		seededChangedFiles: [],
	});

	await writeFile(join(childRoot, "package.json"), "child-new\n", "utf8");

	const exec: ExecLike = async (_command, _args, options) => {
		if (options?.cwd?.startsWith(childRoot)) {
			return {
				stdout: "M package.json\n",
				stderr: "",
				code: 0,
			};
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const plan = await planWorkspaceIntegration({
		childCwd: childRoot,
		parentCwd: parentRoot,
		baseline,
		exec,
	});

	assert.deepEqual(plan.nonConflictingFiles, []);
	assert.deepEqual(plan.conflictingFiles, ["package.json"]);
});
