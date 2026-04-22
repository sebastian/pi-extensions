import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	captureWorkspaceRevision,
	createChildWorkspace,
	createManagedWorkspace,
	createWorkspaceSnapshot,
	detectWorkspaceRepoKind,
	integrateWorkspaceChanges,
	planWorkspaceIntegration,
	reviveManagedWorkspace,
	serializeManagedWorkspace,
} from "../workspaces.ts";
import type { ExecLike } from "../changes.ts";

async function createRepoRoot(prefix: string, kind: "jj" | "git" = "jj"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(root, "src"), { recursive: true });
	if (kind === "jj") await mkdir(join(root, ".jj"));
	else await writeFile(join(root, ".git"), "gitdir: /fake/worktree\n", "utf8");
	return root;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

test("detectWorkspaceRepoKind prefers jj repositories", async () => {
	const root = await createRepoRoot("toolbox-workspaces-");
	assert.equal(detectWorkspaceRepoKind(root), "jj");
});

test("detectWorkspaceRepoKind falls back to git repositories", async () => {
	const root = await createRepoRoot("toolbox-workspaces-", "git");
	assert.equal(detectWorkspaceRepoKind(root), "git");
});

test("createManagedWorkspace seeds source checkout changes into a jj workspace and cleans it up", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");
	const sourceCwd = join(root, "src");
	await writeFile(join(root, "src", "changed.ts"), "source-change\n", "utf8");

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			await mkdir(join(workspacePath, "src"), { recursive: true });
			await writeFile(join(workspacePath, "src", "changed.ts"), "baseline\n", "utf8");
			await writeFile(join(workspacePath, "src", "deleted.ts"), "delete-me\n", "utf8");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return {
				stdout: ["M src/changed.ts", "D src/deleted.ts"].join("\n"),
				stderr: "",
				code: 0,
			};
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "update-stale") {
			return { stdout: "Working copy is not stale.\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const { workspace, seededChangedFiles } = await createManagedWorkspace({
		exec,
		sourceCwd,
		label: "run",
	});

	assert.equal(workspace.kind, "jj");
	assert.equal(workspace.repoRoot, workspace.cwd);
	assert.equal(workspace.sourceRepoRoot, root);
	assert.equal(workspace.sourceCwd, sourceCwd);
	assert.equal(workspace.sourceRelativeCwd, "src");
	assert.notEqual(workspace.workspaceName, "workspace");
	assert.match(workspace.workspaceName, /^toolbox-run-[0-9a-f]{8}$/);
	assert.equal(basename(workspace.cwd), workspace.workspaceName);
	assert.deepEqual(seededChangedFiles, ["src/changed.ts", "src/deleted.ts"]);
	assert.deepEqual(workspace.seededChangedFiles, seededChangedFiles);
	assert.equal(await readFile(join(workspace.cwd, "src", "changed.ts"), "utf8"), "source-change\n");
	assert.equal(await pathExists(join(workspace.cwd, "src", "deleted.ts")), false);

	await workspace.refresh();
	assert.ok(
		calls.some(
			(call) =>
				call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "update-stale" && call.cwd === workspace.cwd,
		),
	);

	const cleanupRoot = workspace.cleanupRoot;
	await workspace.cleanup();
	const forgetCall = calls.find(
		(call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget" && call.cwd === root,
	);
	assert.ok(forgetCall);
	assert.deepEqual(forgetCall.args, ["workspace", "forget", workspace.workspaceName]);
	assert.notEqual(forgetCall.args[2], workspace.cwd);
	assert.equal(await pathExists(cleanupRoot), false);
});

test("reviveManagedWorkspace recreates a cleanup-capable handle from persisted metadata", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "update-stale") {
			return { stdout: "Working copy is not stale.\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const { workspace } = await createManagedWorkspace({ exec, sourceCwd: root, label: "discover" });
	const revived = await reviveManagedWorkspace({ exec, state: serializeManagedWorkspace(workspace) });

	assert.equal(revived.cwd, workspace.cwd);
	await revived.refresh();
	await revived.cleanup();
	assert.ok(
		calls.some((call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget" && call.args[2] === workspace.workspaceName),
	);
});

test("createManagedWorkspace gives same-label jj workspaces distinct generated names", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const [{ workspace: first }, { workspace: second }] = await Promise.all([
		createManagedWorkspace({
			exec,
			sourceCwd: root,
			label: "phase-1",
		}),
		createManagedWorkspace({
			exec,
			sourceCwd: root,
			label: "phase-1",
		}),
	]);

	assert.notEqual(first.workspaceName, second.workspaceName);
	assert.equal(basename(first.cwd), first.workspaceName);
	assert.equal(basename(second.cwd), second.workspaceName);
	assert.notEqual(first.workspaceName, "workspace");
	assert.notEqual(second.workspaceName, "workspace");

	await Promise.all([first.cleanup(), second.cleanup()]);

	assert.deepEqual(
		calls
			.filter((call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget")
			.map((call) => call.args[2])
			.sort(),
		[first.workspaceName, second.workspaceName].sort(),
	);
});

test("createManagedWorkspace bounds cleanup-root names for long labels", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");
	const longLabel = `phase-${"very-long-segment-".repeat(40)}`;

	const exec: ExecLike = async (command, args, options) => {
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const { workspace } = await createManagedWorkspace({
		exec,
		sourceCwd: root,
		label: longLabel,
	});

	assert.ok(basename(workspace.cleanupRoot).length <= 64);
	assert.ok(workspace.workspaceName.length <= 80);

	await workspace.cleanup();
});

test("createManagedWorkspace does not forget a jj workspace when add fails before registration", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	let workspacePath = "";
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			workspacePath = args[2];
			return { stdout: "", stderr: "workspace already exists\n", code: 1 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	await assert.rejects(
		createManagedWorkspace({
			exec,
			sourceCwd: root,
			label: "run",
		}),
		/workspace already exists/,
	);

	assert.ok(workspacePath);
	assert.equal(
		calls.some((call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget"),
		false,
	);
	assert.equal(await pathExists(dirname(workspacePath)), false);
});

test("createManagedWorkspace forgets a registered jj workspace when jj new fails", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	let workspacePath = "";
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "new failed\n", code: 1 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	await assert.rejects(
		createManagedWorkspace({
			exec,
			sourceCwd: root,
			label: "run",
		}),
		/new failed/,
	);

	assert.ok(workspacePath);
	const workspaceName = basename(workspacePath);
	const cleanupRoot = dirname(workspacePath);
	const forgetCall = calls.find(
		(call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget" && call.cwd === root,
	);
	assert.ok(forgetCall);
	assert.deepEqual(forgetCall.args, ["workspace", "forget", workspaceName]);
	assert.equal(await pathExists(cleanupRoot), false);
});

test("createManagedWorkspace cleans up a jj workspace when setup fails after creation", async () => {
	const root = await createRepoRoot("toolbox-jj-workspace-");
	const sourceCwd = join(root, "src");
	await writeFile(join(sourceCwd, "changed.ts"), "source-change\n", "utf8");
	const outside = await mkdtemp(join(tmpdir(), "toolbox-outside-"));

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	let workspacePath = "";
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			await symlink(outside, join(workspacePath, "src"), "dir");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") {
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "M src/changed.ts\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	await assert.rejects(
		createManagedWorkspace({
			exec,
			sourceCwd,
			label: "run",
		}),
		/Refusing to sync workspace path outside the workspace root: src\/changed\.ts/,
	);

	assert.ok(workspacePath);
	const workspaceName = basename(workspacePath);
	const cleanupRoot = dirname(workspacePath);
	const forgetCall = calls.find(
		(call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget",
	);
	assert.ok(forgetCall);
	assert.deepEqual(forgetCall.args, ["workspace", "forget", workspaceName]);
	assert.equal(await pathExists(cleanupRoot), false);
});

test("createManagedWorkspace seeds source checkout changes into a git worktree and cleans it up", async () => {
	const root = await createRepoRoot("toolbox-git-workspace-", "git");
	await writeFile(join(root, "src", "changed.ts"), "source-change\n", "utf8");
	await writeFile(join(root, "src", "new.ts"), "new-file\n", "utf8");

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			const workspacePath = args[3];
			await mkdir(join(workspacePath, "src"), { recursive: true });
			await writeFile(join(workspacePath, ".git"), "gitdir: /fake/worktree\n", "utf8");
			await writeFile(join(workspacePath, "src", "changed.ts"), "baseline\n", "utf8");
			await writeFile(join(workspacePath, "src", "deleted.ts"), "delete-me\n", "utf8");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "git" && args[0] === "diff" && args[1] === "--name-only" && options?.cwd === root) {
			return {
				stdout: ["src/changed.ts", "src/deleted.ts"].join("\n"),
				stderr: "",
				code: 0,
			};
		}
		if (command === "git" && args[0] === "ls-files" && options?.cwd === root) {
			return {
				stdout: "src/new.ts\n",
				stderr: "",
				code: 0,
			};
		}
		if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const { workspace, seededChangedFiles } = await createManagedWorkspace({
		exec,
		sourceCwd: root,
		label: "run",
	});

	assert.equal(workspace.kind, "git");
	assert.equal(workspace.repoRoot, workspace.cwd);
	assert.equal(workspace.sourceRepoRoot, root);
	assert.equal(workspace.sourceRelativeCwd, ".");
	assert.deepEqual(seededChangedFiles, ["src/changed.ts", "src/deleted.ts", "src/new.ts"]);
	assert.equal(await readFile(join(workspace.cwd, "src", "changed.ts"), "utf8"), "source-change\n");
	assert.equal(await readFile(join(workspace.cwd, "src", "new.ts"), "utf8"), "new-file\n");
	assert.equal(await pathExists(join(workspace.cwd, "src", "deleted.ts")), false);

	const cleanupRoot = workspace.cleanupRoot;
	await workspace.cleanup();
	assert.ok(
		calls.some(
			(call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove" && call.cwd === root,
		),
	);
	assert.equal(await pathExists(cleanupRoot), false);
});

test("child workspace edits stay isolated until integration", async () => {
	const root = await createRepoRoot("toolbox-child-isolation-");
	await writeFile(join(root, "src", "isolated.ts"), "source-change\n", "utf8");

	const exec: ExecLike = async (command, args, options) => {
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			await mkdir(join(workspacePath, "src"), { recursive: true });
			await writeFile(join(workspacePath, "src", "isolated.ts"), "baseline\n", "utf8");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") return { stdout: "", stderr: "", code: 0 };
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "M src/isolated.ts\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const child = await createChildWorkspace({
		exec,
		parentCwd: root,
		label: "phase-1",
		touchedPaths: ["src/isolated.ts"],
	});

	await writeFile(join(child.workspace.cwd, "src", "isolated.ts"), "child-only\n", "utf8");
	assert.equal(await readFile(join(root, "src", "isolated.ts"), "utf8"), "source-change\n");

	await child.workspace.cleanup();
});

test("createChildWorkspace baseline includes seeded changes outside the touched paths", async () => {
	const root = await createRepoRoot("toolbox-child-workspace-");
	await writeFile(join(root, "package.json"), '{"name":"changed"}\n', "utf8");

	const exec: ExecLike = async (command, args, options) => {
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			const workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			await mkdir(join(workspacePath, "src"), { recursive: true });
			await writeFile(join(workspacePath, "package.json"), '{"name":"baseline"}\n', "utf8");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") return { stdout: "", stderr: "", code: 0 };
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "M package.json\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const child = await createChildWorkspace({
		exec,
		parentCwd: root,
		label: "phase-1",
		touchedPaths: ["src"],
	});

	assert.deepEqual(child.seededChangedFiles, ["package.json"]);
	assert.deepEqual(Object.keys(child.baseline.files), ["package.json"]);
	assert.equal(await readFile(join(child.workspace.cwd, "package.json"), "utf8"), '{"name":"changed"}\n');

	await child.workspace.cleanup();
});

test("createChildWorkspace cleans up its jj workspace when baseline snapshot creation fails", async () => {
	const root = await createRepoRoot("toolbox-child-workspace-");
	await writeFile(join(root, "src", "changed.ts"), "source-change\n", "utf8");
	const outside = await mkdtemp(join(tmpdir(), "toolbox-outside-"));

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	let workspacePath = "";
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj" && args[0] === "workspace" && args[1] === "add") {
			workspacePath = args[2];
			await mkdir(join(workspacePath, ".jj"), { recursive: true });
			await mkdir(join(workspacePath, "src"), { recursive: true });
			await writeFile(join(workspacePath, "src", "changed.ts"), "baseline\n", "utf8");
			return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "new") return { stdout: "", stderr: "", code: 0 };
		if (command === "jj" && args[0] === "diff" && args[1] === "--summary" && options?.cwd === root) {
			return { stdout: "M src/changed.ts\n", stderr: "", code: 0 };
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "forget") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	await assert.rejects(
		createChildWorkspace({
			exec,
			parentCwd: root,
			label: "phase-1",
			touchedPaths: ["missing"],
			beforeBaselineSnapshot: async (workspace) => {
				const targetFile = join(workspace.repoRoot, "src", "changed.ts");
				assert.equal(await readFile(targetFile, "utf8"), "source-change\n");
				await rm(join(workspace.repoRoot, "src"), { recursive: true, force: true });
				await symlink(outside, join(workspace.repoRoot, "src"), "dir");
			},
		}),
	);

	assert.ok(workspacePath);
	const workspaceName = basename(workspacePath);
	const cleanupRoot = dirname(workspacePath);
	const forgetCall = calls.find(
		(call) => call.command === "jj" && call.args[0] === "workspace" && call.args[1] === "forget",
	);
	assert.ok(forgetCall);
	assert.deepEqual(forgetCall.args, ["workspace", "forget", workspaceName]);
	assert.equal(await pathExists(cleanupRoot), false);
});

test("createWorkspaceSnapshot ignores escaping touched paths", async () => {
	const root = await createRepoRoot("toolbox-workspaces-");
	await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");

	const snapshot = await createWorkspaceSnapshot({
		cwd: root,
		touchedPaths: ["../../outside", "/tmp/outside"],
		seededChangedFiles: [],
	});

	assert.deepEqual(Object.keys(snapshot.files), []);
});

test("createWorkspaceSnapshot skips symlinked directories that point outside the workspace", async () => {
	const root = await createRepoRoot("toolbox-workspaces-");
	const outside = await mkdtemp(join(tmpdir(), "toolbox-outside-"));
	await writeFile(join(outside, "outside.ts"), "outside\n", "utf8");
	await symlink(outside, join(root, "linked"), "dir");

	const snapshot = await createWorkspaceSnapshot({
		cwd: root,
		touchedPaths: ["linked"],
		seededChangedFiles: [],
	});

	assert.deepEqual(Object.keys(snapshot.files), []);
});

test("captureWorkspaceRevision reads the active git or jj revision", async () => {
	const jjRoot = await createRepoRoot("toolbox-workspaces-");
	const gitRoot = await createRepoRoot("toolbox-workspaces-", "git");
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "jj") return { stdout: "jj-commit\n", stderr: "", code: 0 };
		if (command === "git") return { stdout: "git-head\n", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 1 };
	};

	assert.deepEqual(await captureWorkspaceRevision(jjRoot, exec), { kind: "jj", revision: "jj-commit" });
	assert.deepEqual(await captureWorkspaceRevision(gitRoot, exec), { kind: "git", revision: "git-head" });
	assert.deepEqual(
		calls.map((call) => ({ command: call.command, args: call.args })),
		[
			{ command: "jj", args: ["log", "-r", "@", "--no-graph", "-T", "commit_id"] },
			{ command: "git", args: ["rev-parse", "HEAD"] },
		],
	);
});

test("planWorkspaceIntegration separates non-conflicting and conflicting child changes", async () => {
	const parentRoot = await createRepoRoot("toolbox-parent-");
	const childRoot = await createRepoRoot("toolbox-child-");

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
		if (options?.cwd?.startsWith(parentRoot)) {
			return {
				stdout: "M src/same.ts\n",
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

test("planWorkspaceIntegration allows child edits to initially-clean parent files without a full-tree baseline", async () => {
	const parentRoot = await createRepoRoot("toolbox-parent-");
	const childRoot = await createRepoRoot("toolbox-child-");

	await writeFile(join(parentRoot, "src", "fresh.ts"), "baseline\n", "utf8");
	await writeFile(join(childRoot, "src", "fresh.ts"), "baseline\n", "utf8");
	const baseline = await createWorkspaceSnapshot({
		cwd: childRoot,
		touchedPaths: [],
		seededChangedFiles: [],
	});
	await writeFile(join(childRoot, "src", "fresh.ts"), "child-new\n", "utf8");

	const exec: ExecLike = async (_command, _args, options) => {
		if (options?.cwd?.startsWith(childRoot)) {
			return { stdout: "M src/fresh.ts\n", stderr: "", code: 0 };
		}
		if (options?.cwd?.startsWith(parentRoot)) {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const plan = await planWorkspaceIntegration({
		childCwd: childRoot,
		parentCwd: parentRoot,
		baseline,
		exec,
	});

	assert.deepEqual(plan.changedFiles, ["src/fresh.ts"]);
	assert.deepEqual(plan.nonConflictingFiles, ["src/fresh.ts"]);
	assert.deepEqual(plan.conflictingFiles, []);
});

test("integrateWorkspaceChanges syncs only non-conflicting child files", async () => {
	const parentRoot = await createRepoRoot("toolbox-parent-");
	const childRoot = await createRepoRoot("toolbox-child-");

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

	const plan = await integrateWorkspaceChanges({
		childCwd: childRoot,
		parentCwd: parentRoot,
		baseline,
		exec,
	});

	assert.deepEqual(plan.nonConflictingFiles, ["src/new.ts", "src/safe.ts"]);
	assert.deepEqual(plan.conflictingFiles, ["src/same.ts"]);
	assert.equal(await readFile(join(parentRoot, "src", "safe.ts"), "utf8"), "child-safe\n");
	assert.equal(await readFile(join(parentRoot, "src", "new.ts"), "utf8"), "brand new\n");
	assert.equal(await readFile(join(parentRoot, "src", "same.ts"), "utf8"), "parent-new\n");
});

test("integrateWorkspaceChanges can withhold syncing when conflicts remain", async () => {
	const parentRoot = await createRepoRoot("toolbox-parent-");
	const childRoot = await createRepoRoot("toolbox-child-");

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

	const exec: ExecLike = async (_command, _args, options) => {
		if (options?.cwd?.startsWith(childRoot)) {
			return {
				stdout: ["M src/same.ts", "M src/safe.ts"].join("\n"),
				stderr: "",
				code: 0,
			};
		}
		return { stdout: "", stderr: "", code: 0 };
	};

	const plan = await integrateWorkspaceChanges({
		childCwd: childRoot,
		parentCwd: parentRoot,
		baseline,
		exec,
		allowPartialIntegration: false,
	});

	assert.deepEqual(plan.nonConflictingFiles, ["src/safe.ts"]);
	assert.deepEqual(plan.conflictingFiles, ["src/same.ts"]);
	assert.equal(await readFile(join(parentRoot, "src", "safe.ts"), "utf8"), "baseline-safe\n");
	assert.equal(await readFile(join(parentRoot, "src", "same.ts"), "utf8"), "parent-new\n");
});

test("planWorkspaceIntegration treats unexpected edits to existing parent files as conflicts", async () => {
	const parentRoot = await createRepoRoot("toolbox-parent-");
	const childRoot = await createRepoRoot("toolbox-child-");

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
