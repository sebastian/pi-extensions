import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepoKind, findRepoLocation } from "../repo.ts";

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
