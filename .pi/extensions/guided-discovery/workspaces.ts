import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { detectChangedFiles, normalizeRepoRelativePath, type ExecLike } from "./changes.ts";
import { findRepoRoot } from "./guidance.ts";

export type WorkspaceRepoKind = "jj" | "git";

export interface ManagedWorkspace {
	kind: WorkspaceRepoKind;
	cwd: string;
	repoRoot: string;
	cleanupRoot: string;
	cleanup(): Promise<void>;
}

export interface WorkspaceSnapshot {
	baseCwd: string;
	files: Record<string, string | null>;
}

export interface WorkspaceIntegrationPlan {
	changedFiles: string[];
	nonConflictingFiles: string[];
	conflictingFiles: string[];
}

function normalizeFiles(paths: Iterable<string>): string[] {
	return [...new Set(Array.from(paths).map((path) => normalizeRepoRelativePath(path)).filter((path): path is string => Boolean(path)))].sort();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function hashWorkspaceFile(cwd: string, relativePath: string): Promise<string | null> {
	const absolutePath = resolve(cwd, relativePath);
	try {
		const file = await readFile(absolutePath);
		return createHash("sha256").update(file).digest("hex");
	} catch {
		return null;
	}
}

function shouldSkipSnapshotEntry(name: string): boolean {
	return name === ".git" || name === ".jj";
}

async function collectFilesRecursively(root: string, absolutePath: string, collector: Set<string>): Promise<void> {
	if (!(await pathExists(absolutePath))) return;
	const metadata = await stat(absolutePath);
	if (metadata.isDirectory()) {
		for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
			if (shouldSkipSnapshotEntry(entry.name)) continue;
			await collectFilesRecursively(root, join(absolutePath, entry.name), collector);
		}
		return;
	}
	if (!metadata.isFile()) return;
	collector.add(relative(root, absolutePath).replace(/\\/g, "/"));
}

async function collectSnapshotCandidates(options: {
	cwd: string;
	touchedPaths: string[];
	seededChangedFiles: string[];
	includeAllFiles?: boolean;
}): Promise<string[]> {
	const files = new Set<string>(normalizeFiles(options.seededChangedFiles));
	if (options.includeAllFiles) {
		await collectFilesRecursively(options.cwd, options.cwd, files);
		return [...files].sort();
	}
	for (const touchedPath of options.touchedPaths) {
		const normalized = normalizeRepoRelativePath(touchedPath);
		if (!normalized) continue;
		await collectFilesRecursively(options.cwd, resolve(options.cwd, normalized), files);
	}
	return [...files].sort();
}

export async function createWorkspaceSnapshot(options: {
	cwd: string;
	touchedPaths: string[];
	seededChangedFiles: string[];
	includeAllFiles?: boolean;
}): Promise<WorkspaceSnapshot> {
	const files = await collectSnapshotCandidates(options);
	return {
		baseCwd: options.cwd,
		files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hashWorkspaceFile(options.cwd, file)]))),
	};
}

async function syncSingleWorkspaceFile(sourceCwd: string, targetCwd: string, relativePath: string): Promise<void> {
	const sourcePath = resolve(sourceCwd, relativePath);
	const targetPath = resolve(targetCwd, relativePath);
	if (await pathExists(sourcePath)) {
		await mkdir(dirname(targetPath), { recursive: true });
		await copyFile(sourcePath, targetPath);
		return;
	}
	await rm(targetPath, { force: true, recursive: true });
}

export async function syncWorkspaceFiles(options: {
	sourceCwd: string;
	targetCwd: string;
	files: string[];
}): Promise<void> {
	for (const file of normalizeFiles(options.files)) {
		await syncSingleWorkspaceFile(options.sourceCwd, options.targetCwd, file);
	}
}

export function detectWorkspaceRepoKind(cwd: string): WorkspaceRepoKind {
	const repoRoot = findRepoRoot(cwd);
	if (existsSync(join(repoRoot, ".jj"))) return "jj";
	if (existsSync(join(repoRoot, ".git"))) return "git";
	throw new Error(`No jj or git repository detected from ${cwd}`);
}

async function createJjWorkspace(exec: ExecLike, repoRoot: string, workspacePath: string): Promise<void> {
	const createResult = await exec("jj", ["workspace", "add", workspacePath], { cwd: repoRoot, timeout: 60_000 });
	if (createResult.code !== 0) {
		throw new Error(createResult.stderr || createResult.stdout || `Failed to create jj workspace at ${workspacePath}`);
	}
	const newResult = await exec("jj", ["new"], { cwd: workspacePath, timeout: 60_000 });
	if (newResult.code !== 0) {
		throw new Error(newResult.stderr || newResult.stdout || `Failed to create a new jj change in ${workspacePath}`);
	}
}

async function createGitWorkspace(exec: ExecLike, repoRoot: string, workspacePath: string): Promise<void> {
	const createResult = await exec("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], {
		cwd: repoRoot,
		timeout: 60_000,
	});
	if (createResult.code !== 0) {
		throw new Error(createResult.stderr || createResult.stdout || `Failed to create git worktree at ${workspacePath}`);
	}
}

async function cleanupJjWorkspace(exec: ExecLike, repoRoot: string, workspacePath: string): Promise<void> {
	try {
		await exec("jj", ["workspace", "forget", workspacePath], { cwd: repoRoot, timeout: 60_000 });
	} catch {
		// best effort
	}
	await rm(workspacePath, { recursive: true, force: true });
}

async function cleanupGitWorkspace(exec: ExecLike, repoRoot: string, workspacePath: string): Promise<void> {
	try {
		await exec("git", ["worktree", "remove", "--force", workspacePath], { cwd: repoRoot, timeout: 60_000 });
	} catch {
		// best effort
	}
	await rm(workspacePath, { recursive: true, force: true });
}

async function seedWorkspaceFromSource(exec: ExecLike, sourceCwd: string, targetCwd: string): Promise<string[]> {
	const sourceRoot = findRepoRoot(sourceCwd);
	const changedFiles = await detectChangedFiles(sourceCwd, exec);
	await syncWorkspaceFiles({ sourceCwd: sourceRoot, targetCwd, files: changedFiles });
	return changedFiles;
}

export async function createManagedWorkspace(options: {
	exec: ExecLike;
	sourceCwd: string;
	label: string;
}): Promise<{ workspace: ManagedWorkspace; seededChangedFiles: string[] }> {
	const repoRoot = findRepoRoot(options.sourceCwd);
	const kind = detectWorkspaceRepoKind(options.sourceCwd);
	const cleanupRoot = await mkdtemp(join(tmpdir(), `guided-discovery-${options.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-`));
	const workspacePath = join(cleanupRoot, "workspace");
	if (kind === "jj") await createJjWorkspace(options.exec, repoRoot, workspacePath);
	else await createGitWorkspace(options.exec, repoRoot, workspacePath);
	const seededChangedFiles = await seedWorkspaceFromSource(options.exec, options.sourceCwd, workspacePath);
	return {
		workspace: {
			kind,
			cwd: workspacePath,
			repoRoot,
			cleanupRoot,
			cleanup: async () => {
				if (kind === "jj") await cleanupJjWorkspace(options.exec, repoRoot, workspacePath);
				else await cleanupGitWorkspace(options.exec, repoRoot, workspacePath);
				await rm(cleanupRoot, { recursive: true, force: true });
			},
		},
		seededChangedFiles,
	};
}

export async function createChildWorkspace(options: {
	exec: ExecLike;
	parentCwd: string;
	label: string;
	touchedPaths: string[];
}): Promise<{ workspace: ManagedWorkspace; baseline: WorkspaceSnapshot; seededChangedFiles: string[] }> {
	const { workspace, seededChangedFiles } = await createManagedWorkspace({
		exec: options.exec,
		sourceCwd: options.parentCwd,
		label: options.label,
	});
	const baseline = await createWorkspaceSnapshot({
		cwd: workspace.cwd,
		touchedPaths: options.touchedPaths,
		seededChangedFiles,
	});
	return { workspace, baseline, seededChangedFiles };
}

export async function planWorkspaceIntegration(options: {
	childCwd: string;
	parentCwd: string;
	baseline: WorkspaceSnapshot;
	exec: ExecLike;
}): Promise<WorkspaceIntegrationPlan> {
	const changedFiles = normalizeFiles(await detectChangedFiles(options.childCwd, options.exec));
	const materiallyChangedFiles: string[] = [];
	const conflictingFiles: string[] = [];
	const nonConflictingFiles: string[] = [];

	for (const file of changedFiles) {
		const childHash = await hashWorkspaceFile(options.childCwd, file);
		const baselineHash = Object.prototype.hasOwnProperty.call(options.baseline.files, file)
			? options.baseline.files[file]
			: undefined;
		if (baselineHash === childHash) continue;
		materiallyChangedFiles.push(file);
		const parentHash = await hashWorkspaceFile(options.parentCwd, file);
		if (baselineHash === undefined) {
			if (parentHash === null || parentHash === childHash) nonConflictingFiles.push(file);
			else conflictingFiles.push(file);
			continue;
		}
		if (parentHash !== baselineHash && parentHash !== childHash) conflictingFiles.push(file);
		else nonConflictingFiles.push(file);
	}

	return {
		changedFiles: materiallyChangedFiles,
		nonConflictingFiles,
		conflictingFiles,
	};
}
