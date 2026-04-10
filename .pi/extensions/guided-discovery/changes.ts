import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { DecompositionPhase } from "./structured-output.ts";

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
}

export type ExecLike = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResultLike>;

function dedupePaths(paths: string[]): string[] {
	return [...new Set(paths.map(normalizeRepoRelativePath).filter((path): path is string => Boolean(path)))].sort();
}

export function normalizeRepoRelativePath(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const normalized = normalize(trimmed.replace(/^\.\//, "").replace(/^@/, "")).replace(/\\/g, "/");
	if (!normalized || normalized === ".") return null;
	return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}

function expandRenamePath(pathText: string): string[] {
	const normalized = normalizeRepoRelativePath(pathText);
	return normalized ? [normalized] : [];
}

export function parseJjDiffSummary(output: string): string[] {
	const changed: string[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const body = line.replace(/^[A-Z?]+\s+/, "").trim();
		if (!body) continue;
		if (body.includes(" => ")) {
			for (const segment of body.split(/\s+=>\s+/)) {
				changed.push(...expandRenamePath(segment));
			}
			continue;
		}
		changed.push(...expandRenamePath(body));
	}
	return dedupePaths(changed);
}

export function parseGitDiffNameOnly(output: string): string[] {
	return dedupePaths(output.split(/\r?\n/));
}

function isGlobLike(path: string): boolean {
	return /[*?[\]{}]/.test(path);
}

function isPathBroad(path: string): boolean {
	return path === "." || path === "*" || path === "/";
}

function normalizedSegments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

function pathContains(parent: string, child: string): boolean {
	if (parent === child) return true;
	return child.startsWith(`${parent}/`);
}

export function pathsOverlap(left: string[], right: string[]): boolean {
	if (left.length === 0 || right.length === 0) return true;

	for (const rawLeft of left) {
		const leftPath = normalizeRepoRelativePath(rawLeft);
		if (!leftPath || isPathBroad(leftPath) || isGlobLike(leftPath)) return true;
		for (const rawRight of right) {
			const rightPath = normalizeRepoRelativePath(rawRight);
			if (!rightPath || isPathBroad(rightPath) || isGlobLike(rightPath)) return true;
			if (pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)) return true;
			const leftSegments = normalizedSegments(leftPath);
			const rightSegments = normalizedSegments(rightPath);
			if (leftSegments.length === 0 || rightSegments.length === 0) return true;
			if (leftSegments[0] === rightSegments[0] && leftSegments.length === 1 && rightSegments.length === 1) return true;
		}
	}

	return false;
}

function canRunInParallel(existingBatch: DecompositionPhase[], candidate: DecompositionPhase): boolean {
	if (!candidate.parallelSafe) return false;
	if (existingBatch.some((phase) => !phase.parallelSafe)) return false;
	if (existingBatch.some((phase) => candidate.dependsOn.includes(phase.id) || phase.dependsOn.includes(candidate.id))) {
		return false;
	}
	if (existingBatch.some((phase) => pathsOverlap(phase.touchedPaths, candidate.touchedPaths))) {
		return false;
	}
	return true;
}

export function computeExecutionBatches(phases: DecompositionPhase[]): DecompositionPhase[][] {
	const batches: DecompositionPhase[][] = [];
	let currentBatch: DecompositionPhase[] = [];

	for (const phase of phases) {
		if (currentBatch.length === 0) {
			currentBatch = [phase];
			continue;
		}

		if (canRunInParallel(currentBatch, phase)) {
			currentBatch.push(phase);
			continue;
		}

		batches.push(currentBatch);
		currentBatch = [phase];
	}

	if (currentBatch.length > 0) batches.push(currentBatch);
	return batches;
}

function findRepoMarker(start: string, marker: string): string | null {
	let current = start;
	while (true) {
		const candidate = join(current, marker);
		if (existsSync(candidate)) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function findRepoRoot(cwd: string): string | null {
	return findRepoMarker(cwd, ".jj") ?? findRepoMarker(cwd, ".git");
}

function isJjRepo(cwd: string): boolean {
	return findRepoMarker(cwd, ".jj") !== null;
}

function isGitRepo(cwd: string): boolean {
	return findRepoMarker(cwd, ".git") !== null;
}

export async function detectChangedFiles(cwd: string, exec: ExecLike): Promise<string[]> {
	const repoRoot = findRepoRoot(cwd) ?? cwd;

	if (isJjRepo(cwd)) {
		const result = await exec("jj", ["diff", "--summary"], { cwd: repoRoot, timeout: 30_000 });
		if (result.code === 0) return parseJjDiffSummary(result.stdout);
	}

	if (isGitRepo(cwd)) {
		const trackedResult = await exec("git", ["diff", "--name-only", "--relative"], { cwd: repoRoot, timeout: 30_000 });
		const untrackedResult = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
			cwd: repoRoot,
			timeout: 30_000,
		});
		const changedFiles = dedupePaths([
			...(trackedResult.code === 0 ? parseGitDiffNameOnly(trackedResult.stdout) : []),
			...(untrackedResult.code === 0 ? parseGitDiffNameOnly(untrackedResult.stdout) : []),
		]);
		if (changedFiles.length > 0 || (trackedResult.code === 0 && untrackedResult.code === 0)) return changedFiles;
	}

	return [];
}
