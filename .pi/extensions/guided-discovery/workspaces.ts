import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { detectChangedFiles, normalizeRepoRelativePath, type ExecLike } from "./changes.ts";
import { detectRepoKind, findRepoRootOrSelf } from "./repo.ts";

export type WorkspaceRepoKind = "jj" | "git";

export interface ManagedWorkspace {
	kind: WorkspaceRepoKind;
	workspaceName: string;
	cwd: string;
	repoRoot: string;
	sourceRepoRoot: string;
	sourceCwd: string;
	sourceRelativeCwd: string;
	cleanupRoot: string;
	seededChangedFiles: string[];
	refresh(): Promise<void>;
	cleanup(): Promise<void>;
}

export interface SerializedManagedWorkspace {
	kind: WorkspaceRepoKind;
	workspaceName: string;
	cwd: string;
	repoRoot: string;
	sourceRepoRoot: string;
	sourceCwd: string;
	sourceRelativeCwd: string;
	cleanupRoot: string;
	seededChangedFiles: string[];
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

export interface WorkspaceRevision {
	kind: WorkspaceRepoKind;
	revision: string;
}

function normalizeFiles(paths: Iterable<string>): string[] {
	return [...new Set(Array.from(paths).map((path) => normalizeRepoRelativePath(path)).filter((path): path is string => Boolean(path)))].sort();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

const WORKSPACE_LABEL_MAX_LENGTH = 48;
const CLEANUP_ROOT_LABEL_MAX_LENGTH = 24;

function sanitizeWorkspaceLabel(label: string): string {
	const sanitized = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
	return sanitized || "workspace";
}

function createWorkspaceLabelSegment(label: string, maxLength: number): string {
	return sanitizeWorkspaceLabel(label).slice(0, maxLength).replace(/-+$/g, "") || "workspace";
}

function createWorkspaceName(label: string): string {
	const sanitizedLabel = createWorkspaceLabelSegment(label, WORKSPACE_LABEL_MAX_LENGTH);
	const suffix = randomBytes(4).toString("hex");
	return `guided-discovery-${sanitizedLabel}-${suffix}`;
}

function createCleanupRootPrefix(label: string): string {
	const sanitizedLabel = createWorkspaceLabelSegment(label, CLEANUP_ROOT_LABEL_MAX_LENGTH);
	return join(tmpdir(), `guided-discovery-${sanitizedLabel}-`);
}

function normalizeWorkspaceRelativeDirectory(repoRoot: string, cwd: string): string {
	const relativePath = relative(repoRoot, resolve(cwd)).replace(/\\/g, "/");
	return relativePath || ".";
}

async function resolveWorkspaceRelativePath(root: string, relativePath: string): Promise<string | null> {
	const normalizedPath = normalizeRepoRelativePath(relativePath);
	if (!normalizedPath) return null;
	let currentPath = await realpath(root).catch(() => resolve(root));
	for (const segment of normalizedPath.split("/").filter(Boolean)) {
		currentPath = join(currentPath, segment);
		try {
			const metadata = await lstat(currentPath);
			if (metadata.isSymbolicLink()) return null;
		} catch {
			// Once the remaining path does not exist, there is no symlink left to follow.
		}
	}
	return currentPath;
}

async function hashWorkspaceFile(cwd: string, relativePath: string): Promise<string | null> {
	const absolutePath = await resolveWorkspaceRelativePath(cwd, relativePath);
	if (!absolutePath) {
		throw new Error(`Refusing to read workspace path outside the workspace root: ${relativePath}`);
	}
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
	const metadata = await lstat(absolutePath);
	if (metadata.isSymbolicLink()) return;
	if (metadata.isDirectory()) {
		for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
			if (shouldSkipSnapshotEntry(entry.name) || entry.isSymbolicLink()) continue;
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
}): Promise<string[]> {
	const root = await realpath(options.cwd).catch(() => resolve(options.cwd));
	const files = new Set<string>(normalizeFiles(options.seededChangedFiles));
	if (options.touchedPaths.length === 0) {
		await collectFilesRecursively(root, root, files);
		return [...files].sort();
	}
	for (const touchedPath of options.touchedPaths) {
		const absolutePath = await resolveWorkspaceRelativePath(root, touchedPath);
		if (!absolutePath) continue;
		await collectFilesRecursively(root, absolutePath, files);
	}
	return [...files].sort();
}

export async function createWorkspaceSnapshot(options: {
	cwd: string;
	touchedPaths: string[];
	seededChangedFiles: string[];
}): Promise<WorkspaceSnapshot> {
	const files = await collectSnapshotCandidates(options);
	return {
		baseCwd: options.cwd,
		files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hashWorkspaceFile(options.cwd, file)]))),
	};
}

async function syncSingleWorkspaceFile(sourceCwd: string, targetCwd: string, relativePath: string): Promise<void> {
	const sourcePath = await resolveWorkspaceRelativePath(sourceCwd, relativePath);
	const targetPath = await resolveWorkspaceRelativePath(targetCwd, relativePath);
	if (!sourcePath || !targetPath) {
		throw new Error(`Refusing to sync workspace path outside the workspace root: ${relativePath}`);
	}
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
	const kind = detectRepoKind(cwd);
	if (kind) return kind;
	throw new Error(`No jj or git repository detected from ${cwd}`);
}

export async function captureWorkspaceRevision(cwd: string, exec: ExecLike): Promise<WorkspaceRevision> {
	const repoRoot = findRepoRootOrSelf(cwd);
	const kind = detectWorkspaceRepoKind(repoRoot);
	if (kind === "git") {
		const result = await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot, timeout: 30_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || `Failed to resolve git HEAD at ${repoRoot}`);
		}
		return { kind, revision: result.stdout.trim() };
	}
	const result = await exec("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], {
		cwd: repoRoot,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Failed to resolve jj workspace revision at ${repoRoot}`);
	}
	return { kind, revision: result.stdout.trim() };
}

export function workspaceRevisionChanged(expected: WorkspaceRevision, actual: WorkspaceRevision): boolean {
	return expected.kind !== actual.kind || expected.revision !== actual.revision;
}

async function createJjWorkspace(
	exec: ExecLike,
	repoRoot: string,
	workspacePath: string,
	onWorkspaceRegistered?: () => void,
): Promise<void> {
	const createResult = await exec("jj", ["workspace", "add", workspacePath], { cwd: repoRoot, timeout: 60_000 });
	if (createResult.code !== 0) {
		throw new Error(createResult.stderr || createResult.stdout || `Failed to create jj workspace at ${workspacePath}`);
	}
	onWorkspaceRegistered?.();
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

function staleWorkspaceAlreadyCurrent(detail: string): boolean {
	const normalized = detail.toLowerCase();
	return (
		normalized.includes("not stale") ||
		normalized.includes("nothing to update") ||
		normalized.includes("already up to date") ||
		normalized.includes("working copy is not stale")
	);
}

async function refreshJjWorkspace(exec: ExecLike, workspacePath: string): Promise<void> {
	const result = await exec("jj", ["workspace", "update-stale"], { cwd: workspacePath, timeout: 60_000 });
	if (result.code === 0) return;
	const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
	if (detail && staleWorkspaceAlreadyCurrent(detail)) return;
	throw new Error(detail || `Failed to refresh stale jj workspace at ${workspacePath}`);
}

export async function refreshManagedWorkspace(workspace: Pick<ManagedWorkspace, "kind" | "repoRoot">, exec: ExecLike): Promise<void> {
	if (workspace.kind === "jj") {
		await refreshJjWorkspace(exec, workspace.repoRoot);
	}
}

async function cleanupJjWorkspace(
	exec: ExecLike,
	repoRoot: string,
	workspaceName: string,
	workspacePath: string,
	workspaceRegistered: boolean,
): Promise<void> {
	if (workspaceRegistered) {
		try {
			await exec("jj", ["workspace", "forget", workspaceName], { cwd: repoRoot, timeout: 60_000 });
		} catch {
			// best effort
		}
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

async function cleanupManagedWorkspace(options: {
	exec: ExecLike;
	kind: WorkspaceRepoKind;
	repoRoot: string;
	workspaceName: string;
	workspacePath: string;
	cleanupRoot: string;
	jjWorkspaceRegistered: boolean;
}): Promise<void> {
	try {
		if (options.kind === "jj") {
			await cleanupJjWorkspace(
				options.exec,
				options.repoRoot,
				options.workspaceName,
				options.workspacePath,
				options.jjWorkspaceRegistered,
			);
		} else {
			await cleanupGitWorkspace(options.exec, options.repoRoot, options.workspacePath);
		}
	} finally {
		await rm(options.cleanupRoot, { recursive: true, force: true });
	}
}

export function serializeManagedWorkspace(workspace: ManagedWorkspace): SerializedManagedWorkspace {
	return {
		kind: workspace.kind,
		workspaceName: workspace.workspaceName,
		cwd: workspace.cwd,
		repoRoot: workspace.repoRoot,
		sourceRepoRoot: workspace.sourceRepoRoot,
		sourceCwd: workspace.sourceCwd,
		sourceRelativeCwd: workspace.sourceRelativeCwd,
		cleanupRoot: workspace.cleanupRoot,
		seededChangedFiles: [...workspace.seededChangedFiles],
	};
}

export async function reviveManagedWorkspace(options: {
	exec: ExecLike;
	state: SerializedManagedWorkspace;
}): Promise<ManagedWorkspace> {
	const state = {
		...options.state,
		cwd: resolve(options.state.cwd),
		repoRoot: resolve(options.state.repoRoot),
		sourceRepoRoot: resolve(options.state.sourceRepoRoot),
		sourceCwd: resolve(options.state.sourceCwd),
		cleanupRoot: resolve(options.state.cleanupRoot),
	};
	if (!(await pathExists(state.cwd))) {
		throw new Error(`Managed workspace no longer exists at ${state.cwd}`);
	}
	return {
		kind: state.kind,
		workspaceName: state.workspaceName,
		cwd: state.cwd,
		repoRoot: state.repoRoot,
		sourceRepoRoot: state.sourceRepoRoot,
		sourceCwd: state.sourceCwd,
		sourceRelativeCwd: state.sourceRelativeCwd,
		cleanupRoot: state.cleanupRoot,
		seededChangedFiles: [...state.seededChangedFiles],
		refresh: async () => {
			await refreshManagedWorkspace({ kind: state.kind, repoRoot: state.repoRoot }, options.exec);
		},
		cleanup: async () => {
			await cleanupManagedWorkspace({
				exec: options.exec,
				kind: state.kind,
				repoRoot: state.sourceRepoRoot,
				workspaceName: state.workspaceName,
				workspacePath: state.cwd,
				cleanupRoot: state.cleanupRoot,
				jjWorkspaceRegistered: state.kind === "jj",
			});
		},
	};
}

async function seedWorkspaceFromSource(exec: ExecLike, sourceCwd: string, targetRepoRoot: string): Promise<string[]> {
	const sourceRepoRoot = findRepoRootOrSelf(sourceCwd);
	const changedFiles = await detectChangedFiles(sourceCwd, exec);
	await syncWorkspaceFiles({ sourceCwd: sourceRepoRoot, targetCwd: targetRepoRoot, files: changedFiles });
	return changedFiles;
}

export async function createManagedWorkspace(options: {
	exec: ExecLike;
	sourceCwd: string;
	label: string;
}): Promise<{ workspace: ManagedWorkspace; seededChangedFiles: string[] }> {
	const sourceCwd = resolve(options.sourceCwd);
	const sourceRepoRoot = findRepoRootOrSelf(sourceCwd);
	const kind = detectWorkspaceRepoKind(sourceCwd);
	const workspaceName = createWorkspaceName(options.label);
	const cleanupRoot = await mkdtemp(createCleanupRootPrefix(options.label));
	const workspacePath = join(cleanupRoot, workspaceName);
	let jjWorkspaceRegistered = false;

	try {
		if (kind === "jj") {
			await createJjWorkspace(options.exec, sourceRepoRoot, workspacePath, () => {
				jjWorkspaceRegistered = true;
			});
		} else {
			await createGitWorkspace(options.exec, sourceRepoRoot, workspacePath);
		}
		const repoRoot = findRepoRootOrSelf(workspacePath);
		const seededChangedFiles = await seedWorkspaceFromSource(options.exec, sourceCwd, repoRoot);
		const workspace: ManagedWorkspace = {
			kind,
			workspaceName,
			cwd: workspacePath,
			repoRoot,
			sourceRepoRoot,
			sourceCwd,
			sourceRelativeCwd: normalizeWorkspaceRelativeDirectory(sourceRepoRoot, sourceCwd),
			cleanupRoot,
			seededChangedFiles: [...seededChangedFiles],
			refresh: async () => {
				await refreshManagedWorkspace({ kind, repoRoot }, options.exec);
			},
			cleanup: async () => {
				await cleanupManagedWorkspace({
					exec: options.exec,
					kind,
					repoRoot: sourceRepoRoot,
					workspaceName,
					workspacePath,
					cleanupRoot,
					jjWorkspaceRegistered,
				});
			},
		};
		return { workspace, seededChangedFiles };
	} catch (error) {
		await cleanupManagedWorkspace({
			exec: options.exec,
			kind,
			repoRoot: sourceRepoRoot,
			workspaceName,
			workspacePath,
			cleanupRoot,
			jjWorkspaceRegistered,
		}).catch(() => {});
		throw error;
	}
}

export async function createChildWorkspace(options: {
	exec: ExecLike;
	parentCwd: string;
	label: string;
	touchedPaths: string[];
	beforeBaselineSnapshot?: (workspace: ManagedWorkspace) => Promise<void> | void;
}): Promise<{ workspace: ManagedWorkspace; baseline: WorkspaceSnapshot; seededChangedFiles: string[] }> {
	const { workspace, seededChangedFiles } = await createManagedWorkspace({
		exec: options.exec,
		sourceCwd: options.parentCwd,
		label: options.label,
	});
	try {
		await options.beforeBaselineSnapshot?.(workspace);
		const baseline = await createWorkspaceSnapshot({
			cwd: workspace.repoRoot,
			touchedPaths: options.touchedPaths,
			seededChangedFiles,
		});
		return { workspace, baseline, seededChangedFiles };
	} catch (error) {
		await workspace.cleanup().catch(() => {});
		throw error;
	}
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

export async function integrateWorkspaceChanges(options: {
	childCwd: string;
	parentCwd: string;
	baseline: WorkspaceSnapshot;
	exec: ExecLike;
	allowPartialIntegration?: boolean;
}): Promise<WorkspaceIntegrationPlan> {
	const integration = await planWorkspaceIntegration(options);
	if (options.allowPartialIntegration === false && integration.conflictingFiles.length > 0) return integration;
	if (integration.nonConflictingFiles.length > 0) {
		await syncWorkspaceFiles({
			sourceCwd: options.childCwd,
			targetCwd: options.parentCwd,
			files: integration.nonConflictingFiles,
		});
	}
	return integration;
}
