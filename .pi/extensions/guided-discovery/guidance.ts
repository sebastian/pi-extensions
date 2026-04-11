import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { normalizeRepoRelativePath } from "./changes.ts";
import { findRepoRootOrSelf } from "./repo.ts";

export interface RelevantGuidanceDocument {
	path: string;
	relativePath: string;
	content: string;
	appliesTo: string[];
}

export interface RelevantGuidanceResult {
	repoRoot: string;
	documents: RelevantGuidanceDocument[];
}

function fileExists(path: string): boolean {
	return existsSync(path);
}

function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function pathStaysWithinRoot(root: string, target: string): boolean {
	const relativeToRoot = relative(root, target).replace(/\\/g, "/");
	return relativeToRoot === "" || (relativeToRoot !== ".." && !relativeToRoot.startsWith("../"));
}

function resolvePathWithinRoot(root: string, targetPath: string): string | null {
	const realRoot = safeRealpath(root) ?? resolve(root);
	let existingPath = resolve(targetPath);
	while (!fileExists(existingPath)) {
		const parent = dirname(existingPath);
		if (parent === existingPath) return null;
		existingPath = parent;
	}
	const realExistingPath = safeRealpath(existingPath);
	if (!realExistingPath || !pathStaysWithinRoot(realRoot, realExistingPath)) return null;
	const remainder = relative(existingPath, resolve(targetPath));
	const resolvedTarget = remainder && remainder !== "." ? resolve(realExistingPath, remainder) : realExistingPath;
	return pathStaysWithinRoot(realRoot, resolvedTarget) ? resolvedTarget : null;
}

export function findRepoRoot(start: string): string {
	return findRepoRootOrSelf(start);
}

export function discoverAncestorDocumentPaths(start: string, stopAt: string, fileName: string): string[] {
	const files: string[] = [];
	let current = resolve(start);
	while (true) {
		files.push(join(current, fileName));
		if (current === stopAt) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return [...new Set(files)].filter(fileExists).reverse();
}

function resolveGuidanceTarget(repoRoot: string, changedPath: string): { normalizedPath: string; absolutePath: string } | null {
	const normalizedPath = normalizeRepoRelativePath(changedPath);
	if (!normalizedPath) return null;
	const absolutePath = resolvePathWithinRoot(repoRoot, resolve(repoRoot, normalizedPath));
	if (!absolutePath) return null;
	return { normalizedPath, absolutePath };
}

function guidanceStartDirectory(repoRoot: string, changedPath: string): { normalizedPath: string; startDirectory: string } | null {
	const target = resolveGuidanceTarget(repoRoot, changedPath);
	if (!target) return null;
	if (existsSync(target.absolutePath)) {
		try {
			if (lstatSync(target.absolutePath).isDirectory()) {
				return { normalizedPath: target.normalizedPath, startDirectory: target.absolutePath };
			}
		} catch {
			// fall through to parent-directory heuristics
		}
	}
	return { normalizedPath: target.normalizedPath, startDirectory: dirname(target.absolutePath) };
}

export function discoverRelevantGuidance(cwd: string, changedFiles: string[], fileName = "AGENTS.md"): RelevantGuidanceResult {
	const repoRoot = findRepoRoot(cwd);
	const realRepoRoot = safeRealpath(repoRoot) ?? repoRoot;
	const documents = new Map<string, RelevantGuidanceDocument>();

	for (const changedFile of changedFiles) {
		const target = guidanceStartDirectory(realRepoRoot, changedFile);
		if (!target) continue;
		const appliesToPath = target.normalizedPath;
		let currentDir = target.startDirectory;

		while (true) {
			const candidate = join(currentDir, fileName);
			if (fileExists(candidate)) {
				const realCandidate = safeRealpath(candidate);
				if (realCandidate && pathStaysWithinRoot(realRepoRoot, realCandidate)) {
					if (!documents.has(realCandidate)) {
						documents.set(realCandidate, {
							path: realCandidate,
							relativePath: relative(realRepoRoot, realCandidate).replace(/\\/g, "/"),
							content: readFileSync(realCandidate, "utf8"),
							appliesTo: [appliesToPath],
						});
					} else {
						const document = documents.get(realCandidate)!;
						if (!document.appliesTo.includes(appliesToPath)) document.appliesTo.push(appliesToPath);
					}
				}
			}

			if (currentDir === realRepoRoot) break;
			const parent = dirname(currentDir);
			if (parent === currentDir) break;
			currentDir = parent;
		}
	}

	return {
		repoRoot: realRepoRoot,
		documents: Array.from(documents.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
	};
}

export function collectRelevantGuidancePaths(cwd: string, changedFiles: string[], fileName = "AGENTS.md"): string[] {
	return discoverRelevantGuidance(cwd, changedFiles, fileName).documents.map((document) => document.path);
}

export function renderGuidanceSummary(result: RelevantGuidanceResult, label = "AGENTS.md"): string {
	const lines = [`## Relevant ${label} guidance`, ""];
	if (result.documents.length === 0) {
		lines.push(`No ${label} documents were discovered for the changed files.`);
	} else {
		for (const document of result.documents) {
			lines.push(`- ${document.relativePath} -> ${document.appliesTo.join(", ")}`);
		}
	}
	return `${lines.join("\n").trim()}\n`;
}
