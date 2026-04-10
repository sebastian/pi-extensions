import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

export function findRepoRoot(start: string): string {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(start);
		current = parent;
	}
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

function guidanceStartDirectory(repoRoot: string, changedPath: string): string {
	const absolutePath = resolve(repoRoot, changedPath);
	if (existsSync(absolutePath)) {
		try {
			if (statSync(absolutePath).isDirectory()) return absolutePath;
		} catch {
			// fall through to parent-directory heuristics
		}
	}
	return dirname(absolutePath);
}

export function discoverRelevantGuidance(cwd: string, changedFiles: string[], fileName = "AGENTS.md"): RelevantGuidanceResult {
	const repoRoot = findRepoRoot(cwd);
	const documents = new Map<string, RelevantGuidanceDocument>();

	for (const changedFile of changedFiles) {
		let currentDir = guidanceStartDirectory(repoRoot, changedFile);

		while (true) {
			const candidate = join(currentDir, fileName);
			if (fileExists(candidate)) {
				if (!documents.has(candidate)) {
					documents.set(candidate, {
						path: candidate,
						relativePath: relative(repoRoot, candidate).replace(/\\/g, "/"),
						content: readFileSync(candidate, "utf8"),
						appliesTo: [changedFile],
					});
				} else {
					const document = documents.get(candidate)!;
					if (!document.appliesTo.includes(changedFile)) document.appliesTo.push(changedFile);
				}
			}

			if (currentDir === repoRoot) break;
			const parent = dirname(currentDir);
			if (parent === currentDir) break;
			currentDir = parent;
		}
	}

	return {
		repoRoot,
		documents: Array.from(documents.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
	};
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
