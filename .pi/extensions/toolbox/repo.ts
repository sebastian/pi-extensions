import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RepoKind = "jj" | "git";

export interface RepoLocation {
	root: string;
	kind: RepoKind;
}

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
