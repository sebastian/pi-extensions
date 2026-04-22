import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecLike } from "../changes.ts";
import {
	detectRepoKind,
	findRepoLocation,
	formatJjRepoMetadata,
	parseJjRepoMetadata,
	readJjRepoMetadata,
} from "../repo.ts";

test("findRepoLocation prefers jj over colocated git metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-repo-"));
	await mkdir(join(root, ".jj"), { recursive: true });
	await writeFile(join(root, ".git"), "gitdir: /fake/worktree\n", "utf8");
	await mkdir(join(root, "src"), { recursive: true });

	assert.deepEqual(findRepoLocation(join(root, "src")), { root, kind: "jj" });
});

test("detectRepoKind identifies jj repositories from nested paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-repo-"));
	await mkdir(join(root, ".jj"), { recursive: true });
	await mkdir(join(root, "src", "nested"), { recursive: true });

	assert.equal(detectRepoKind(join(root, "src", "nested")), "jj");
});

test("parseJjRepoMetadata falls back to a placeholder description", () => {
	assert.deepEqual(parseJjRepoMetadata("pzzzuuol\n39cc93d2\n"), {
		changeId: "pzzzuuol",
		commitId: "39cc93d2",
		description: "(no description)",
	});
});

test("formatJjRepoMetadata renders a footer-friendly label", () => {
	assert.equal(
		formatJjRepoMetadata({
			changeId: "pzzzuuol",
			commitId: "39cc93d2",
			description: "Show jj change metadata instead of detached git head",
		}),
		"jj pzzzuuol • Show jj change metadata instead of detached git head",
	);
});

test("readJjRepoMetadata queries the current jj change", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-repo-"));
	await mkdir(join(root, ".jj"), { recursive: true });

	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const exec: ExecLike = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		return {
			stdout: "pzzzuuol\n39cc93d2\nShow jj change metadata instead of detached git head\n",
			stderr: "",
			code: 0,
		};
	};

	assert.deepEqual(await readJjRepoMetadata(root, exec), {
		changeId: "pzzzuuol",
		commitId: "39cc93d2",
		description: "Show jj change metadata instead of detached git head",
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		command: "jj",
		args: [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id.short(8) ++ "\\n" ++ commit_id.short(8) ++ "\\n" ++ description.first_line()',
		],
		cwd: root,
	});
});

test("readJjRepoMetadata returns null outside jj repositories", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-repo-"));
	const exec: ExecLike = async () => {
		throw new Error("should not be called");
	};

	assert.equal(await readJjRepoMetadata(root, exec), null);
});
