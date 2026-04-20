import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecLike } from "./changes.ts";

export type RepoKind = "jj" | "git";

export interface RepoLocation {
	root: string;
	kind: RepoKind;
}

export interface JjRepoMetadata {
	changeId: string;
	commitId: string;
	description: string;
}

const JJ_REPO_METADATA_TEMPLATE = 'change_id.short(8) ++ "\\n" ++ commit_id.short(8) ++ "\\n" ++ description.first_line()';

export function findRepoLocation(start: string): RepoLocation | null {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".jj"))) return { root: current, kind: "jj" };
		if (existsSync(join(current, ".git"))) return { root: current, kind: "git" };
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function findRepoRoot(start: string): string | null {
	return findRepoLocation(start)?.root ?? null;
}

export function findRepoRootOrSelf(start: string): string {
	return findRepoRoot(start) ?? resolve(start);
}

export function detectRepoKind(start: string): RepoKind | null {
	return findRepoLocation(start)?.kind ?? null;
}

export function parseJjRepoMetadata(output: string): JjRepoMetadata | null {
	const normalized = output.replace(/\r/g, "").trimEnd();
	if (!normalized.trim()) return null;
	const [rawChangeId = "", rawCommitId = "", ...rawDescription] = normalized.split("\n");
	const changeId = rawChangeId.trim();
	const commitId = rawCommitId.trim();
	if (!changeId || !commitId) return null;
	const description = rawDescription.join("\n").trim() || "(no description)";
	return { changeId, commitId, description };
}

export function formatJjRepoMetadata(metadata: JjRepoMetadata): string {
	return `jj ${metadata.changeId} • ${metadata.description || "(no description)"}`;
}

export async function readJjRepoMetadata(start: string, exec: ExecLike): Promise<JjRepoMetadata | null> {
	const repo = findRepoLocation(start);
	if (!repo || repo.kind !== "jj") return null;
	const result = await exec("jj", ["log", "-r", "@", "--no-graph", "-T", JJ_REPO_METADATA_TEMPLATE], {
		cwd: repo.root,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Failed to read jj change metadata at ${repo.root}`);
	}
	return parseJjRepoMetadata(result.stdout);
}
