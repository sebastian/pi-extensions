import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { computeExecutionBatches, detectChangedFiles, pathsOverlap, type ExecLike } from "./changes.ts";
import {
	appendAgentsChecksToCheckerReport,
	collectAgentsCheckCommands,
	runAgentsCheckCommands,
	type AgentsCheckCommand,
	type AgentsCheckExecutionPolicy,
} from "./agents-checks.ts";
import {
	collectRelevantGuidancePaths,
	discoverAncestorDocumentPaths,
	discoverRelevantGuidance,
	findRepoRoot,
	renderGuidanceSummary,
	type RelevantGuidanceResult,
} from "./guidance.ts";
import { resolveWorkflowModels } from "./models.ts";
import { runSubagent, type SubagentUsageTotals } from "./subagent-runner.ts";
import {
	captureWorkspaceRevision,
	createChildWorkspace,
	createManagedWorkspace,
	createWorkspaceSnapshot,
	integrateWorkspaceChanges,
	reviveManagedWorkspace,
	serializeManagedWorkspace,
	workspaceRevisionChanged,
	type ManagedWorkspace,
	type SerializedManagedWorkspace,
	type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
	parseCheckerReport,
	parseDecompositionPlan,
	parseValidationReport,
	type CheckerFindingCategory,
	type CheckerReport,
	type DecompositionPhase,
	type DecompositionPlan,
	type FindingSeverity,
	type ValidationDiscrepancy,
	type ValidationReport,
} from "./structured-output.ts";
import type {
	ProgressEventContext,
	WorkflowEdgeId,
	WorkflowNodeId,
	WorkflowProgressUpdate,
} from "./implementation-progress.ts";

const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];
const WORKER_SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const QUALITY_SUITE_MAX_ROUNDS = 3;
export const QUALITY_SUITE_MAX_EXTRA_ROUNDS = 2;
export const TARGETED_FOLLOW_THROUGH_MAX_ROUNDS = 2;
export const FINAL_CHECKER_MAX_PASSES = 2;
const QUALITY_SUITE_STAGNATION_LIMIT = 2;

const DESIGN_PATH_PATTERN =
	/(^|[\/_.-])(ui|ux|screen|screens|view|views|page|pages|component|components|widget|widgets|layout|layouts|style|styles|theme|themes|navigation|nav|menu|toolbar|modal|dialog|sheet|panel|form|copy|content|onboarding|tui)([\/_.-]|$)/i;
const DESIGN_FILE_EXTENSION_PATTERN = /\.(tsx|jsx|css|scss|sass|less|html|mdx)$/i;
const DESIGN_TEXT_PATTERN =
	/\b(ui|ux|discoverability|discoverable|affordance|navigation|hierarchy|interaction|accessibility|inclusive|inclusivity|legibility|onboarding|screen|product behavior|product behaviour|cognitive load|primary action|wayfinding)\b/i;
const LEGACY_CLEANUP_PATTERN = /\b(legacy|obsolete|superseded|dead code|dead state|unused|stale|retire)\b/i;

const QUALITY_STAGE_FIX_EDGE: Record<QualityStageId, WorkflowEdgeId> = {
	cleanup: "cleanup->fix",
	design: "design->fix",
	checker: "checker->fix",
};

export type CheckRunSummary = {
	command: string;
	source: string;
	status: "passed" | "failed" | "blocked" | "error";
	summary: string;
};

interface CheckerModelRun {
	model: string;
	report: CheckerReport;
	summary: CheckRunSummary;
}

interface CheckerSuiteResult {
	report: CheckerReport;
	guidance: RelevantGuidanceResult;
	results: CheckRunSummary[];
	agentsCheckResults: CheckRunSummary[];
	modelRuns: CheckerModelRun[];
}

type WorkflowDecision = "done" | "stopped" | "reformulate";
export type ImplementationMode = "direct" | "subagents";
export type SubagentWorkflowMode = "fast" | "strict";
export type WorkerPromptKind = "worker" | "design-worker";
export type QualityStageId = "cleanup" | "design" | "checker";

export interface ParsedImplementationRequest {
	mode?: ImplementationMode;
	extraInstructions: string;
}

export type StandaloneSubagentRequest =
	| { kind: "plan"; planPath: string }
	| { kind: "raw-prompt"; rawPrompt: string }
	| { kind: "missing-plan"; message: string };

interface WorkflowOptions {
	planPath?: string;
	rawPrompt?: string;
	extraInstructions: string;
	workflowMode?: SubagentWorkflowMode;
	resumeState?: ResumableImplementationState;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onUsage?: (usage: SubagentUsageTotals) => void;
}

export interface SerializedWorkerPhaseResult {
	phase: DecompositionPhase;
	summary: string;
}

interface WorkerPhaseResult extends SerializedWorkerPhaseResult {}

export interface ResumableImplementationState {
	workspace: SerializedManagedWorkspace;
	originalRepoRoot: string;
	workflowMode: SubagentWorkflowMode;
	planDocument: string;
	extraInstructions: string;
	decomposition: DecompositionPlan;
	workerResults: SerializedWorkerPhaseResult[];
}

interface WorkflowSummary {
	decision: WorkflowDecision;
	summary: string;
	reformulationPrompt?: string;
	resumableState?: ResumableImplementationState;
}

let currentWorkflowSubagentUsageSink: ((usage: SubagentUsageTotals) => void) | undefined;

function forwardWorkflowSubagentUsage(usage: SubagentUsageTotals): void {
	currentWorkflowSubagentUsageSink?.(usage);
}

export interface WorkerPromptSelection {
	kind: WorkerPromptKind;
	systemPrompt: string;
	promptLabel: string;
	designSensitive: boolean;
	reason: string;
}

interface SpecialistReviewRun {
	report: CheckerReport;
	guidance: RelevantGuidanceResult;
	summary: CheckRunSummary;
}

export type QualityGateClassification = "hard" | "soft";
export type QualitySuiteSoftGateChoice =
	| "Accept remaining soft findings and continue"
	| "Continue remediation anyway"
	| "Reformulate in discovery mode";

export interface QualityGateFindingSummary {
	stage: QualityStageId;
	category: CheckerFindingCategory;
	severity: FindingSeverity;
	summary: string;
	paths: string[];
	classification: QualityGateClassification;
}

export interface FinalCheckerHardGateDecision {
	round: number;
	roundBudget: {
		base: number;
		extra: number;
		total: number;
	};
	message: string;
	changedFiles: string[];
	hardGateFindings: QualityGateFindingSummary[];
	softGateFindings: QualityGateFindingSummary[];
	checkerRun: CheckerSuiteResult;
}

export type FinalCheckerHardGateChoice = "Continue remediation anyway" | "Stop and summarize current progress";

export interface QualitySuiteRoundSnapshot {
	round: number;
	hardFindingCount: number;
	softFindingCount: number;
	totalFindingCount: number;
	weightedScore: number;
}

export interface QualitySuiteRoundDecision {
	action: "pass" | "remediate" | "prompt" | "fail";
	designReviewStatus: "ran" | "skipped";
	triggerStages: QualityStageId[];
	findingCounts: Record<QualityStageId, number>;
	hardFindingCounts: Record<QualityStageId, number>;
	softFindingCounts: Record<QualityStageId, number>;
	hardGateFindings: QualityGateFindingSummary[];
	softGateFindings: QualityGateFindingSummary[];
	materialProgress: boolean;
	stagnationCount: number;
	roundBudget: {
		base: number;
		extra: number;
		total: number;
	};
	snapshot: QualitySuiteRoundSnapshot;
	restartStage?: "cleanup";
	message?: string;
}

interface QualitySuiteResult {
	outcome: "pass" | "accepted-soft";
	acceptedResidualSoftFindings: QualityGateFindingSummary[];
	blockingHardFindings: QualityGateFindingSummary[];
	changedFiles: string[];
	cleanupRun: SpecialistReviewRun;
	designRun: SpecialistReviewRun | null;
	checkerRun: CheckerSuiteResult;
	stats: WorkflowQualityStats;
}

interface WorkflowQualityStats {
	cleanupRuns: number;
	designReviewRuns: number;
	designReviewSkips: number;
	checkerRuns: number;
	remediationPasses: number;
	fixedFindingSignatures: Record<QualityStageId, Set<string>>;
	agentsCheckResults: CheckRunSummary[];
	pendingLegacyCleanupFindingSignatures: Set<string>;
	legacyCodeOrFilesRemoved: boolean;
	mergedResultVerificationRuns: number;
	mergedResultVerificationReasons: Set<string>;
}

export interface AgentsCheckHistorySummary {
	trackedCommands: number;
	finalPassed: number;
	finalFailed: number;
	finalBlocked: number;
	finalErrored: number;
	failedAtLeastOnce: number;
	blockedAtLeastOnce: number;
	erroredAtLeastOnce: number;
	failedThenFixed: number;
}

export interface WorkflowQualitySummary {
	cleanupRuns: number;
	designReviewRuns: number;
	designReviewSkips: number;
	checkerRuns: number;
	remediationPasses: number;
	fixedFindings: Record<QualityStageId, number> & { total: number };
	agentsChecks: AgentsCheckHistorySummary;
	legacyCodeOrFilesRemoved: boolean;
	mergedResultVerificationRuns: number;
	mergedResultVerificationReasons: string[];
}

function trimBlock(text: string): string {
	return text.trim() ? `${text.trim()}\n` : "";
}

export function parseImplementationRequest(rawArgs: string): ParsedImplementationRequest {
	let text = rawArgs.trim();
	let mode: ImplementationMode | undefined;

	text = text.replace(/^--mode\s+(direct|subagents?|subagent)\b\s*/i, (_match, matchedMode: string) => {
		mode = matchedMode.toLowerCase().startsWith("direct") ? "direct" : "subagents";
		return "";
	});

	if (!mode) {
		text = text.replace(/^(direct|subagents?|subagent)\b[:\s-]*/i, (_match, matchedMode: string) => {
			mode = matchedMode.toLowerCase().startsWith("direct") ? "direct" : "subagents";
			return "";
		});
	}

	return { mode, extraInstructions: text.trim() };
}

export function resolveStandaloneSubagentRequest(options: {
	rawArgs: string;
	planPath: string;
	hasPlanFile: boolean;
}): StandaloneSubagentRequest {
	const rawPrompt = options.rawArgs.trim();
	if (rawPrompt) return { kind: "raw-prompt", rawPrompt };
	if (options.hasPlanFile) return { kind: "plan", planPath: options.planPath };
	return {
		kind: "missing-plan",
		message: "No PLAN.md found. Pass a raw prompt or create PLAN.md first.",
	};
}

async function readBundledPrompt(name: string): Promise<string> {
	return readFile(new URL(`./agents/${name}.md`, import.meta.url), "utf8");
}

async function existingFiles(paths: string[]): Promise<string[]> {
	const existing: string[] = [];
	for (const path of paths) {
		try {
			await readFile(path, "utf8");
			existing.push(path);
		} catch {
			// ignore missing files
		}
	}
	return existing;
}

async function writeTempContextFile(tempDir: string, name: string, content: string): Promise<string> {
	const filePath = join(tempDir, name);
	await writeFile(filePath, trimBlock(content), "utf8");
	return filePath;
}

async function materializeResumedWorkflowPlan(tempDir: string, planDocument: string): Promise<string> {
	const workflowPlanPath = join(tempDir, "PLAN.md");
	await writeFile(workflowPlanPath, trimBlock(planDocument), "utf8");
	return workflowPlanPath;
}

function cloneWorkerResults(results: SerializedWorkerPhaseResult[]): WorkerPhaseResult[] {
	return structuredClone(results) as WorkerPhaseResult[];
}

function cloneDecompositionPlan(plan: DecompositionPlan): DecompositionPlan {
	return structuredClone(plan) as DecompositionPlan;
}

function buildResumableImplementationState(options: {
	runWorkspace: ManagedWorkspace;
	originalRepoRoot: string;
	workflowMode: SubagentWorkflowMode;
	planDocument: string;
	extraInstructions: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
}): ResumableImplementationState {
	return {
		workspace: serializeManagedWorkspace(options.runWorkspace),
		originalRepoRoot: options.originalRepoRoot,
		workflowMode: options.workflowMode,
		planDocument: options.planDocument,
		extraInstructions: options.extraInstructions,
		decomposition: cloneDecompositionPlan(options.decomposition),
		workerResults: cloneWorkerResults(options.workerResults),
	};
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function filterChangedFilesToScope(changedFiles: string[], touchedPaths: string[]): string[] {
	if (touchedPaths.length === 0) return uniquePaths(changedFiles);
	return uniquePaths(changedFiles.filter((file) => pathsOverlap([file], touchedPaths)));
}

function buildTargetedReviewFiles(options: {
	changedFiles: string[];
	touchedPaths: string[];
	extraPaths?: string[];
}): string[] {
	const scopedChangedFiles = filterChangedFilesToScope(options.changedFiles, options.touchedPaths);
	return uniquePaths([...scopedChangedFiles, ...options.touchedPaths, ...(options.extraPaths ?? [])]);
}

function renderTargetedFollowThroughScopeContext(options: {
	phase: DecompositionPhase;
	round: number;
	changedFiles: string[];
	touchedPaths: string[];
	discrepancyContextText?: string;
}): string {
	return trimBlock(
		[
			"## Review scope",
			"",
			"mode: targeted phase follow-through",
			`round: ${options.round}/${TARGETED_FOLLOW_THROUGH_MAX_ROUNDS}`,
			`phase: ${options.phase.id} — ${options.phase.title}`,
			`goal: ${options.phase.goal}`,
			`changed files in scope: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			`declared touched paths: ${options.touchedPaths.length > 0 ? options.touchedPaths.join(", ") : "none provided"}`,
			"",
			"Scope rules:",
			"- Focus only on this phase's changed files and declared touched paths.",
			"- You may inspect immediate surrounding code, nearby callsites, importers, tests, and config only when directly relevant to this phase.",
			"- Do not roam into unrelated repo-wide cleanup or redesign opportunities.",
			"- Prefer no finding over speculative polish.",
			...(options.discrepancyContextText?.trim() ? ["", "## Additional targeted context", "", options.discrepancyContextText.trim()] : []),
		].join("\n"),
	);
}

function renderFinalHolisticScopeContext(options: {
	changedFiles: string[];
	workerResults: WorkerPhaseResult[];
	discrepancyContextText?: string;
}): string {
	return trimBlock(
		[
			"## Review scope",
			"",
			"mode: final holistic feature review",
			`changed files in scope: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			`implemented phases: ${options.workerResults.length}`,
			"",
			"Scope rules:",
			"- Review the whole changed feature once, but only for glaring feature-level issues.",
			"- Do not generate a wishlist or a broad refactor backlog.",
			"- Non-critical polish should be reported sparingly and is not a blocking loop trigger here.",
			...(options.discrepancyContextText?.trim() ? ["", "## Additional validation context", "", options.discrepancyContextText.trim()] : []),
		].join("\n"),
	);
}

function renderFinalCheckerScopeContext(options: {
	round: number;
	totalPasses: number;
	changedFiles: string[];
	softFindings: QualityGateFindingSummary[];
}): string {
	return trimBlock(
		[
			"## Review scope",
			"",
			"mode: final checker loop",
			`checker pass: ${options.round}/${options.totalPasses}`,
			`changed files in scope: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			"",
			"Checker focus:",
			"- logic bugs and correctness issues",
			"- regressions and unintended side effects",
			"- security, guidance, and important behavioral gaps",
			"- avoid spending attention on cleanup or polish unless it creates a concrete bug or regression risk",
			...(options.softFindings.length > 0
				? [
					"",
					"## Non-blocking holistic cleanup/design notes already reported",
					"",
					...options.softFindings.map(
						(finding) =>
							`- ${finding.stage}/${finding.category} [${finding.severity}]: ${finding.summary}${finding.paths.length > 0 ? ` (${finding.paths.join(", ")})` : ""}`,
					),
				]
				: []),
		].join("\n"),
	);
}

function normalizeAgentFilePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return trimmed;
	try {
		return realpathSync(trimmed);
	} catch {
		return trimmed;
	}
}

export function collectWorkerAgentFiles(
	baseAgentFiles: string[],
	cwd: string,
	touchedPaths: string[],
	extraFiles: string[] = [],
): string[] {
	return uniquePaths(
		[...baseAgentFiles, ...collectRelevantGuidancePaths(cwd, touchedPaths, "AGENTS.md"), ...extraFiles].map(normalizeAgentFilePath),
	);
}

export async function synthesizeImplementationPlan(options: {
	cwd: string;
	tempDir: string;
	agentFiles: string[];
	plannerPrompt: string;
	rawPrompt: string;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
	runSubagentFn?: typeof runSubagent;
}): Promise<string> {
	const requestPath = await writeTempContextFile(
		options.tempDir,
		"implementation-request.md",
		[
			"## Raw implementation request",
			"",
			options.rawPrompt.trim(),
			...(options.extraInstructions.trim()
				? ["", "## Additional instructions", "", options.extraInstructions.trim()]
				: []),
		].join("\n"),
	);
	const runSubagentFn = options.runSubagentFn ?? runSubagent;
	const result = await runSubagentFn({
		cwd: options.cwd,
		systemPrompt: options.plannerPrompt,
		prompt: "Create a lightweight implementation plan for the attached request. Output markdown only.",
		files: [...options.agentFiles, requestPath],
		tools: READ_ONLY_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
	});
	const planText = ensureSuccessfulSubagent("implementation planner", result);
	const planPath = join(options.tempDir, "PLAN.md");
	await writeFile(planPath, trimBlock(planText), "utf8");
	return planPath;
}

export async function materializeWorkflowPlan(options: {
	cwd: string;
	tempDir: string;
	agentFiles: string[];
	planPath?: string;
	rawPrompt?: string;
	plannerPrompt: string;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
	runSubagentFn?: typeof runSubagent;
}): Promise<{ planPath: string; label: string }> {
	if (options.rawPrompt?.trim()) {
		return {
			planPath: await synthesizeImplementationPlan({
				cwd: options.cwd,
				tempDir: options.tempDir,
				agentFiles: options.agentFiles,
				plannerPrompt: options.plannerPrompt,
				rawPrompt: options.rawPrompt,
				extraInstructions: options.extraInstructions,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				runSubagentFn: options.runSubagentFn,
			}),
			label: "the synthesized lightweight plan",
		};
	}
	if (!options.planPath) throw new Error("Sub-agent implementation requires either planPath or rawPrompt.");
	const sourcePlanPath = resolve(options.cwd, options.planPath);
	const planText = await readFile(sourcePlanPath, "utf8");
	const workflowPlanPath = join(options.tempDir, "PLAN.md");
	await writeFile(workflowPlanPath, trimBlock(planText), "utf8");
	return { planPath: workflowPlanPath, label: sourcePlanPath };
}

function makeExec(pi: ExtensionAPI): ExecLike {
	return async (command, args, options) => {
		const result = await pi.exec(command, args, options);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
		};
	};
}

function renderDecompositionSummary(decomposition: DecompositionPlan): string {
	const lines = ["## Decomposed phases", ""];
	for (const phase of decomposition.phases) {
		lines.push(`### ${phase.id}: ${phase.title}`);
		lines.push(`- goal: ${phase.goal}`);
		lines.push(`- dependsOn: ${phase.dependsOn.length > 0 ? phase.dependsOn.join(", ") : "none"}`);
		lines.push(`- touchedPaths: ${phase.touchedPaths.length > 0 ? phase.touchedPaths.join(", ") : "unknown"}`);
		lines.push(`- parallelSafe: ${phase.parallelSafe ? "yes" : "no"}`);
		lines.push(`- designSensitive: ${phase.designSensitive ? "yes" : "no"}`);
		for (const instruction of phase.instructions) {
			lines.push(`  - ${instruction}`);
		}
		lines.push("");
	}
	if (decomposition.notes.length > 0) {
		lines.push("## Decomposer notes", "", ...decomposition.notes.map((note) => `- ${note}`));
	}
	return trimBlock(lines.join("\n"));
}

function renderChangedFilesSummary(changedFiles: string[]): string {
	const lines = ["## Changed files", ""];
	if (changedFiles.length === 0) {
		lines.push("No changed files detected.");
	} else {
		for (const file of changedFiles) lines.push(`- ${file}`);
	}
	return trimBlock(lines.join("\n"));
}

function renderWorkerPhaseSummaries(results: WorkerPhaseResult[]): string {
	const lines = ["## Worker phase summaries", ""];
	for (const result of results) {
		lines.push(`### ${result.phase.id}: ${result.phase.title}`);
		lines.push(`- goal: ${result.phase.goal}`);
		lines.push(`- touchedPaths: ${result.phase.touchedPaths.length > 0 ? result.phase.touchedPaths.join(", ") : "unknown"}`);
		lines.push(`- designSensitive: ${result.phase.designSensitive ? "yes" : "no"}`);
		lines.push("");
		lines.push(result.summary || "(no summary)");
		lines.push("");
	}
	return trimBlock(lines.join("\n"));
}

function renderRelevantGuidanceSummary(result: RelevantGuidanceResult): string {
	return renderGuidanceSummary(result, "AGENTS.md");
}

function renderCheckResultsSummary(results: CheckRunSummary[]): string {
	const lines = ["## Checks run", ""];
	if (results.length === 0) {
		lines.push("No checker reviews were recorded.");
	} else {
		for (const result of results) {
			lines.push(`- ${result.command} (${result.source}) => ${result.status}: ${result.summary}`);
		}
	}
	return trimBlock(lines.join("\n"));
}

function isAgentsCheckResult(result: Pick<CheckRunSummary, "source">): boolean {
	return /(?:^|,\s*)[^,]*AGENTS\.md(?:$|,)/.test(result.source);
}

function agentsCheckHistoryKey(result: Pick<CheckRunSummary, "command" | "source">): string {
	return `${result.command}\u0000${result.source}`;
}

export function summarizeAgentsCheckHistory(results: CheckRunSummary[]): AgentsCheckHistorySummary {
	const history = new Map<string, CheckRunSummary["status"][]>();
	for (const result of results) {
		if (!isAgentsCheckResult(result)) continue;
		const key = agentsCheckHistoryKey(result);
		const statuses = history.get(key) ?? [];
		statuses.push(result.status);
		history.set(key, statuses);
	}

	const summary: AgentsCheckHistorySummary = {
		trackedCommands: history.size,
		finalPassed: 0,
		finalFailed: 0,
		finalBlocked: 0,
		finalErrored: 0,
		failedAtLeastOnce: 0,
		blockedAtLeastOnce: 0,
		erroredAtLeastOnce: 0,
		failedThenFixed: 0,
	};

	for (const statuses of history.values()) {
		const finalStatus = statuses[statuses.length - 1];
		const sawFailed = statuses.includes("failed");
		const sawBlocked = statuses.includes("blocked");
		const sawErrored = statuses.includes("error");
		if (sawFailed) summary.failedAtLeastOnce += 1;
		if (sawBlocked) summary.blockedAtLeastOnce += 1;
		if (sawErrored) summary.erroredAtLeastOnce += 1;
		if ((sawFailed || sawErrored) && finalStatus === "passed") summary.failedThenFixed += 1;
		if (finalStatus === "passed") summary.finalPassed += 1;
		else if (finalStatus === "failed") summary.finalFailed += 1;
		else if (finalStatus === "blocked") summary.finalBlocked += 1;
		else if (finalStatus === "error") summary.finalErrored += 1;
	}

	return summary;
}

function summarizeAgentsCheckCommands(commands: AgentsCheckCommand[], maxItems = 5): string[] {
	return commands.slice(0, maxItems).map((command) => `${command.command} (${command.source})`);
}

function agentsCheckCommandSetKey(commands: AgentsCheckCommand[]): string {
	return [...commands]
		.map((command) => `${command.command}\u0000${command.source}`)
		.sort()
		.join("\u0001");
}

async function requestAgentsCheckExecutionPolicy(
	ctx: ExtensionContext,
	commands: AgentsCheckCommand[],
): Promise<AgentsCheckExecutionPolicy> {
	if (commands.length === 0) return { allowed: true };
	if (!ctx.hasUI) {
		return {
			allowed: true,
			reason: "Non-interactive sub-agent mode runs only sanitized argv-style AGENTS.md checks inside the isolated workspace.",
		};
	}
	const approved = await ctx.ui.confirm(
		"Allow AGENTS.md check commands to run?",
		[
			"These repository-authored AGENTS.md checks will execute in the isolated workspace.",
			"Approve only if you trust the repo and the requested commands.",
			"",
			...summarizeAgentsCheckCommands(commands),
			...(commands.length > 5 ? [`+${commands.length - 5} more`] : []),
		].join("\n"),
	);
	return approved
		? { allowed: true }
		: {
			allowed: false,
			reason: "You declined execution of repository-authored AGENTS.md check commands for this workflow.",
		};
}

function renderFindingReportSummary(title: string, report: CheckerReport): string {
	const lines = [`## ${title}`, ""];
	if (report.findings.length === 0) {
		lines.push("No actionable findings.");
	} else {
		for (const finding of report.findings) {
			lines.push(`- [${finding.severity}] ${finding.category}: ${finding.summary}`);
			if (finding.details) lines.push(`  - details: ${finding.details}`);
			if (finding.suggestedFix) lines.push(`  - suggested fix: ${finding.suggestedFix}`);
			if (finding.paths.length > 0) lines.push(`  - paths: ${finding.paths.join(", ")}`);
		}
	}
	if (report.unresolvedRisks.length > 0) {
		lines.push("", "## Unresolved risks", "", ...report.unresolvedRisks.map((risk) => `- ${risk}`));
	}
	return trimBlock(lines.join("\n"));
}

function renderCheckerFindingsSummary(report: CheckerReport): string {
	return renderFindingReportSummary("Checker findings", report);
}

function renderDiscrepancyListItem(discrepancy: ValidationDiscrepancy): string[] {
	const lines = [`- ${discrepancy.id ? `${discrepancy.id} — ` : ""}${discrepancy.status}: ${discrepancy.item}`];
	lines.push(`  - why not done: ${discrepancy.reason || "(not provided)"}`);
	lines.push(`  - worth implementing now: ${discrepancy.worthImplementingNow ? "yes" : "no"}`);
	lines.push(`  - worthwhile rationale: ${discrepancy.worthwhileRationale || "(not provided)"}`);
	if (discrepancy.suggestedAction) lines.push(`  - suggested action: ${discrepancy.suggestedAction}`);
	return lines;
}

function renderDiscrepancySection(title: string, discrepancies: ValidationDiscrepancy[], emptyMessage: string): string {
	const lines = [`## ${title}`, ""];
	if (discrepancies.length === 0) {
		lines.push(emptyMessage);
	} else {
		for (const discrepancy of discrepancies) {
			lines.push(...renderDiscrepancyListItem(discrepancy));
		}
	}
	return trimBlock(lines.join("\n"));
}

export function renderValidationSummary(report: ValidationReport): string {
	const lines = ["## Validator summary", "", report.summary || "(no summary)", "", "## Coverage", ""];
	for (const item of report.coverage) {
		lines.push(`- ${item.status}: ${item.item}${item.evidence ? ` — ${item.evidence}` : ""}`);
	}
	if (report.discrepancies.length > 0) {
		lines.push("", renderDiscrepancySection("Discrepancies", report.discrepancies, "No discrepancies."));
	}
	lines.push("", `Recommendation: ${report.recommendation}`);
	return trimBlock(lines.join("\n"));
}

function mergeUniqueText(parts: string[]): string {
	const unique = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
	return unique.join("\n\n");
}

function severityRank(severity: "low" | "medium" | "high"): number {
	return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function combineCheckerReports(modelRuns: CheckerModelRun[]): CheckerReport {
	const findingMap = new Map<
		string,
		CheckerReport["findings"][number] & {
			reporters: Set<string>;
			detailParts: string[];
			fixParts: string[];
		}
	>();
	const unresolvedRisks = new Set<string>();
	const checksRun: CheckRunSummary[] = [];
	const assessments: string[] = [];

	for (const run of modelRuns) {
		checksRun.push(run.summary);
		if (run.report.overallAssessment) assessments.push(`${run.model}: ${run.report.overallAssessment}`);
		for (const risk of run.report.unresolvedRisks) unresolvedRisks.add(risk);
		for (const finding of run.report.findings) {
			const key = [finding.category, finding.summary.trim().toLowerCase(), [...finding.paths].sort().join(",")].join("|");
			const existing = findingMap.get(key);
			const taggedDetails = finding.details ? `${run.model}: ${finding.details}` : "";
			const taggedFix = finding.suggestedFix ? `${run.model}: ${finding.suggestedFix}` : "";
			if (!existing) {
				findingMap.set(key, {
					...finding,
					reporters: new Set([run.model]),
					detailParts: taggedDetails ? [taggedDetails] : [],
					fixParts: taggedFix ? [taggedFix] : [],
				});
				continue;
			}

			existing.reporters.add(run.model);
			existing.paths = [...new Set([...existing.paths, ...finding.paths])].sort();
			if (severityRank(finding.severity) > severityRank(existing.severity)) existing.severity = finding.severity;
			if (taggedDetails) existing.detailParts.push(taggedDetails);
			if (taggedFix) existing.fixParts.push(taggedFix);
		}
	}

	const findings = Array.from(findingMap.values()).map((finding, index) => ({
		id: finding.id || `finding-${index + 1}`,
		category: finding.category,
		severity: finding.severity,
		summary: finding.summary,
		details: mergeUniqueText([
			`Reported by: ${Array.from(finding.reporters).join(", ")}`,
			...finding.detailParts,
		]),
		suggestedFix: mergeUniqueText(finding.fixParts),
		paths: finding.paths,
	}));

	return {
		findings,
		checksRun,
		unresolvedRisks: Array.from(unresolvedRisks),
		overallAssessment: assessments.join("\n"),
	};
}

function isActionableDiscrepancy(discrepancy: ValidationDiscrepancy): boolean {
	return discrepancy.status === "missing" || discrepancy.status === "partial";
}

export function renderUnresolvedDiscrepancySummary(discrepancies: ValidationDiscrepancy[]): string {
	if (discrepancies.length === 0) {
		return trimBlock(["## Remaining validator discrepancies", "", "No unresolved discrepancies."].join("\n"));
	}
	const actionableDiscrepancies = discrepancies.filter(isActionableDiscrepancy);
	const informationalDiscrepancies = discrepancies.filter((discrepancy) => !isActionableDiscrepancy(discrepancy));
	return trimBlock(
		[
			"## Remaining validator discrepancies",
			"",
			`Actionable: ${actionableDiscrepancies.length}`,
			`Informational (superseded): ${informationalDiscrepancies.length}`,
			"",
			renderDiscrepancySection(
				"Actionable discrepancies",
				actionableDiscrepancies,
				"No actionable discrepancies remain.",
			),
			"",
			renderDiscrepancySection(
				"Informational discrepancies",
				informationalDiscrepancies,
				"No informational discrepancies remain.",
			),
		].join("\n"),
	);
}

function renderQualityGateFindingsSection(
	title: string,
	findings: QualityGateFindingSummary[],
	emptyMessage: string,
): string {
	const lines = [`## ${title}`, ""];
	if (findings.length === 0) {
		lines.push(emptyMessage);
	} else {
		for (const finding of findings) {
			lines.push(
				`- [${finding.severity}] ${finding.stage}/${finding.category}: ${finding.summary}${finding.paths.length > 0 ? ` (${finding.paths.join(", ")})` : ""}`,
			);
		}
	}
	return trimBlock(lines.join("\n"));
}

export function buildSummary(
	changedFiles: string[],
	checks: CheckRunSummary[],
	validation: ValidationReport,
	checker: CheckerReport,
	quality: WorkflowQualitySummary,
	qualityOutcome: {
		acceptedResidualSoftFindings: QualityGateFindingSummary[];
		blockingHardFindings: QualityGateFindingSummary[];
	},
): string {
	const passedChecks = checks.filter((check) => check.status === "passed").length;
	const failedChecks = checks.filter((check) => check.status === "failed").length;
	const blockedChecks = checks.filter((check) => check.status === "blocked").length;
	const erroredChecks = checks.filter((check) => check.status === "error").length;
	return trimBlock(
		[
			[
				"Sub-agent implementation workflow finished.",
				changedFiles.length > 0 ? `Changed files (${changedFiles.length}): ${changedFiles.join(", ")}` : "Changed files: none detected",
				`Cleanup audits: ${quality.cleanupRuns}`,
				`Design reviews: ${quality.designReviewRuns} run, ${quality.designReviewSkips} skipped`,
				`Quality remediation passes: ${quality.remediationPasses}`,
				`Fixed quality findings: cleanup ${quality.fixedFindings.cleanup}, design ${quality.fixedFindings.design}, checker ${quality.fixedFindings.checker}, total ${quality.fixedFindings.total}`,
				`Accepted residual soft quality issues: ${qualityOutcome.acceptedResidualSoftFindings.length}`,
				`Blocking hard quality issues: ${qualityOutcome.blockingHardFindings.length}`,
				`Merged-result verification passes: ${quality.mergedResultVerificationRuns}${quality.mergedResultVerificationReasons.length > 0 ? ` (${quality.mergedResultVerificationReasons.join("; ")})` : ""}`,
				`Legacy code/files removed (verified): ${quality.legacyCodeOrFilesRemoved ? "yes" : "no"}`,
				`Final code review findings: ${checker.findings.length}`,
				`Checks run in final code review: ${passedChecks} passed, ${failedChecks} flagged findings, ${blockedChecks} blocked, ${erroredChecks} errored`,
				quality.agentsChecks.trackedCommands > 0
					? `AGENTS-required checks across verification passes: ${quality.agentsChecks.trackedCommands} tracked, ${quality.agentsChecks.finalPassed} passing in the final pass, ${quality.agentsChecks.failedThenFixed} failed then fixed, ${quality.agentsChecks.finalFailed} still failing, ${quality.agentsChecks.finalBlocked} blocked, ${quality.agentsChecks.finalErrored} errored`
					: "AGENTS-required checks across verification passes: none discovered",
				`Validator recommendation: ${validation.recommendation}`,
				`Remaining plan discrepancies: ${validation.discrepancies.length}`,
				"Validator follow-through: disabled by design (single advisory coverage pass only)",
				validation.discrepancies.length > 0
					? "Remaining plan discrepancies are reported below instead of triggering more remediation loops."
					: "Validator found no remaining plan discrepancies.",
				validation.summary || "",
			].join("\n"),
			renderQualityGateFindingsSection(
				"Accepted residual soft quality issues",
				qualityOutcome.acceptedResidualSoftFindings,
				"No accepted residual soft quality issues.",
			),
			renderQualityGateFindingsSection(
				"Blocking hard quality issues",
				qualityOutcome.blockingHardFindings,
				"No blocking hard quality issues remain.",
			),
			renderUnresolvedDiscrepancySummary(validation.discrepancies),
		].join("\n\n"),
	);
}

function renderCompletedWorkSection(workerResults: WorkerPhaseResult[], maxItems = 10): string {
	const completedEntries = [...new Set(workerResults.map((result) => `${result.phase.id} — ${result.phase.title}`.trim()).filter(Boolean))];
	const lines = ["## Completed work", ""];
	if (completedEntries.length === 0) {
		lines.push("No implementation phases completed before the workflow stopped.");
	} else {
		lines.push(`Completed phase/result entries: ${workerResults.length}`);
		lines.push("");
		for (const entry of completedEntries.slice(0, maxItems)) lines.push(`- ${entry}`);
		if (completedEntries.length > maxItems) lines.push(`- … ${completedEntries.length - maxItems} more`);
	}
	return trimBlock(lines.join("\n"));
}

export function buildStoppedSummary(options: {
	reason: string;
	changedFiles: string[];
	checks: CheckRunSummary[];
	checker: CheckerReport;
	quality: WorkflowQualitySummary;
	workerResults: WorkerPhaseResult[];
	acceptedResidualSoftFindings: QualityGateFindingSummary[];
	blockingHardFindings: QualityGateFindingSummary[];
}): string {
	const passedChecks = options.checks.filter((check) => check.status === "passed").length;
	const failedChecks = options.checks.filter((check) => check.status === "failed").length;
	const blockedChecks = options.checks.filter((check) => check.status === "blocked").length;
	const erroredChecks = options.checks.filter((check) => check.status === "error").length;
	return trimBlock(
		[
			[
				"Sub-agent implementation workflow stopped before applying the isolated workspace result.",
				`Reason: ${options.reason}`,
				options.changedFiles.length > 0
					? `Changed files (${options.changedFiles.length}): ${options.changedFiles.join(", ")}`
					: "Changed files: none detected",
				`Cleanup audits: ${options.quality.cleanupRuns}`,
				`Design reviews: ${options.quality.designReviewRuns} run, ${options.quality.designReviewSkips} skipped`,
				`Quality remediation passes: ${options.quality.remediationPasses}`,
				`Fixed quality findings before stopping: cleanup ${options.quality.fixedFindings.cleanup}, design ${options.quality.fixedFindings.design}, checker ${options.quality.fixedFindings.checker}, total ${options.quality.fixedFindings.total}`,
				`Accepted residual soft quality issues already surfaced: ${options.acceptedResidualSoftFindings.length}`,
				`Blocking hard quality issues still remaining: ${options.blockingHardFindings.length}`,
				`Merged-result verification passes: ${options.quality.mergedResultVerificationRuns}${options.quality.mergedResultVerificationReasons.length > 0 ? ` (${options.quality.mergedResultVerificationReasons.join("; ")})` : ""}`,
				`Legacy code/files removed (verified): ${options.quality.legacyCodeOrFilesRemoved ? "yes" : "no"}`,
				`Final code review findings at stop: ${options.checker.findings.length}`,
				`Checks run in final code review: ${passedChecks} passed, ${failedChecks} flagged findings, ${blockedChecks} blocked, ${erroredChecks} errored`,
				options.quality.agentsChecks.trackedCommands > 0
					? `AGENTS-required checks across verification passes: ${options.quality.agentsChecks.trackedCommands} tracked, ${options.quality.agentsChecks.finalPassed} passing in the latest pass, ${options.quality.agentsChecks.failedThenFixed} failed then fixed, ${options.quality.agentsChecks.finalFailed} still failing, ${options.quality.agentsChecks.finalBlocked} blocked, ${options.quality.agentsChecks.finalErrored} errored`
					: "AGENTS-required checks across verification passes: none discovered",
				"Validator status: skipped because hard-blocking quality issues remained after the bounded final checker loop.",
				"The isolated workspace result was not applied to the original checkout.",
			].join("\n"),
			renderCompletedWorkSection(options.workerResults),
			renderQualityGateFindingsSection(
				"Remaining hard quality issues",
				options.blockingHardFindings,
				"No blocking hard quality issues remain.",
			),
			renderQualityGateFindingsSection(
				"Residual soft quality issues already surfaced",
				options.acceptedResidualSoftFindings,
				"No residual soft quality issues were recorded.",
			),
			trimBlock(
				[
					"## Next steps",
					"",
					"- Continue remediation from the preserved isolated workspace with /implement-subagents-resume if you want another bounded attempt without starting over.",
					"- Or switch back into discovery if the remaining blockers suggest the plan needs to change before more implementation work.",
				].join("\n"),
			),
		].join("\n\n"),
	);
}

function buildQualityReformulationPrompt(findings: QualityGateFindingSummary[]): string {
	return trimBlock(
		[
			"Please reformulate the approved plan based on the merged-result quality issues below.",
			"Keep already-good work, but simplify or reshape the plan where the quality suite shows the implementation is not converging cleanly.",
			"Use PLAN.md as the source of truth and produce a fresh final plan when ready.",
			"",
			renderQualityGateFindingsSection(
				"Merged-result quality issues to address in a reformulated plan",
				findings,
				"No remaining quality issues were recorded.",
			),
		].join("\n"),
	).trim();
}

function buildQualityReformulationSummary(options: {
	changedFiles: string[];
	checks: CheckRunSummary[];
	checker: CheckerReport;
	quality: WorkflowQualitySummary;
	softFindings: QualityGateFindingSummary[];
	hardFindings: QualityGateFindingSummary[];
}): string {
	const passedChecks = options.checks.filter((check) => check.status === "passed").length;
	const failedChecks = options.checks.filter((check) => check.status === "failed").length;
	const blockedChecks = options.checks.filter((check) => check.status === "blocked").length;
	const erroredChecks = options.checks.filter((check) => check.status === "error").length;
	return trimBlock(
		[
			[
				"Sub-agent implementation workflow paused for discovery reformulation before validator completion.",
				options.changedFiles.length > 0
					? `Changed files (${options.changedFiles.length}): ${options.changedFiles.join(", ")}`
					: "Changed files: none detected",
				`Fixed quality findings: cleanup ${options.quality.fixedFindings.cleanup}, design ${options.quality.fixedFindings.design}, checker ${options.quality.fixedFindings.checker}, total ${options.quality.fixedFindings.total}`,
				`Merged-result verification passes: ${options.quality.mergedResultVerificationRuns}${options.quality.mergedResultVerificationReasons.length > 0 ? ` (${options.quality.mergedResultVerificationReasons.join("; ")})` : ""}`,
				`Final checker findings before reformulation: ${options.checker.findings.length}`,
				`Checks run in final merged-result verification: ${passedChecks} passed, ${failedChecks} flagged findings, ${blockedChecks} blocked, ${erroredChecks} errored`,
			].join("\n"),
			renderQualityGateFindingsSection(
				"Accepted or remaining soft quality issues",
				options.softFindings,
				"No soft quality issues were recorded.",
			),
			renderQualityGateFindingsSection(
				"Blocking hard quality issues",
				options.hardFindings,
				"No blocking hard quality issues were recorded.",
			),
		].join("\n\n"),
	);
}

function buildReformulationPrompt(validation: ValidationReport): string {
	return trimBlock(
		[
			"Please reformulate the approved plan based on the implementation discrepancies below.",
			"Keep the parts that already worked, and update the plan only where the validator found meaningful gaps or superseded decisions.",
			"Use PLAN.md as the source of truth and produce a fresh final plan when ready.",
			"",
			`Validator summary: ${validation.summary || "(no summary provided)"}`,
			"",
			renderUnresolvedDiscrepancySummary(validation.discrepancies),
		].join("\n"),
	).trim();
}

function summarizePaths(paths: string[], maxItems = 4): string {
	const normalized = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
	if (normalized.length === 0) return "unknown";
	if (normalized.length <= maxItems) return normalized.join(", ");
	return `${normalized.slice(0, maxItems).join(", ")} +${normalized.length - maxItems} more`;
}

function summarizeFindingsList(findings: CheckerReport["findings"], maxItems = 3): string[] {
	return findings.slice(0, maxItems).map((finding) => `${finding.severity} ${finding.category}: ${finding.summary}`);
}

function summarizeCheckerFindings(report: CheckerReport, maxItems = 3): string[] {
	return summarizeFindingsList(report.findings, maxItems);
}

function summarizeDiscrepancies(discrepancies: ValidationDiscrepancy[], maxItems = 3): string[] {
	return discrepancies.slice(0, maxItems).map((item) => `${item.status}: ${item.item}`);
}


class QualitySuiteReformulateError extends Error {
	summary: string;
	reformulationPrompt: string;

	constructor(options: { summary: string; reformulationPrompt: string }) {
		super("Quality suite requested discovery reformulation.");
		this.name = "QualitySuiteReformulateError";
		this.summary = options.summary;
		this.reformulationPrompt = options.reformulationPrompt;
	}
}

async function promptForQualitySuiteSoftGateChoice(
	ctx: ExtensionContext,
	decision: QualitySuiteRoundDecision,
): Promise<QualitySuiteSoftGateChoice> {
	if (decision.hardGateFindings.length > 0) {
		throw new Error("Soft-gate prompt received hard blockers unexpectedly.");
	}
	const softFindingSummary = decision.softGateFindings
		.slice(0, 5)
		.map((finding) => `- [${finding.severity}] ${finding.stage}/${finding.category}: ${finding.summary}`)
		.join("\n");
	return (await ctx.ui.select(
		[
			decision.message || "Only soft quality findings remain.",
			`${decision.softGateFindings.length} residual soft finding(s) remain. No hard blockers remain.`,
			decision.materialProgress
				? `The latest round improved materially, but the bounded retry budget is now ${decision.roundBudget.total} round(s).`
				: `The latest round did not materially improve. Stagnation count: ${decision.stagnationCount}.`,
			softFindingSummary,
		].filter(Boolean).join("\n\n"),
		[
			"Accept remaining soft findings and continue",
			"Continue remediation anyway",
			"Reformulate in discovery mode",
		],
	)) as QualitySuiteSoftGateChoice;
}

async function promptForFinalCheckerHardGateChoice(
	ctx: ExtensionContext,
	decision: FinalCheckerHardGateDecision,
): Promise<FinalCheckerHardGateChoice> {
	const hardFindingSummary = decision.hardGateFindings
		.slice(0, 5)
		.map((finding) => `- [${finding.severity}] ${finding.stage}/${finding.category}: ${finding.summary}`)
		.join("\n");
	return (await ctx.ui.select(
		[
			decision.message,
			`${decision.hardGateFindings.length} hard-blocking finding(s) remain after ${decision.roundBudget.total} final checker pass(es).`,
			`Changed files in the isolated workspace: ${summarizePaths(decision.changedFiles)}`,
			"Choose whether to keep iterating inside the isolated workspace or stop gracefully with a summary of what was completed and what remains.",
			hardFindingSummary,
		].filter(Boolean).join("\n\n"),
		["Continue remediation anyway", "Stop and summarize current progress"],
	)) as FinalCheckerHardGateChoice;
}

function emitWorkflowUpdate(onUpdate: WorkflowOptions["onUpdate"], update: WorkflowProgressUpdate): void {
	onUpdate?.({
		...update,
		lines: [...update.lines],
		detailLines: update.detailLines ? [...update.detailLines] : [...update.lines],
		context: update.context
			? {
				...update.context,
				touchedPaths: update.context.touchedPaths ? [...update.context.touchedPaths] : undefined,
				changedFiles: update.context.changedFiles ? [...update.context.changedFiles] : undefined,
				checkerModels: update.context.checkerModels ? [...update.context.checkerModels] : undefined,
				discrepancySummary: update.context.discrepancySummary ? [...update.context.discrepancySummary] : undefined,
			}
			: undefined,
	});
}

function emitLoopTraversal(
	onUpdate: WorkflowOptions["onUpdate"],
	edge: WorkflowEdgeId,
	stage: string,
	lines: string[],
	context?: ProgressEventContext,
	count?: number,
): void {
	emitWorkflowUpdate(onUpdate, {
		type: "loop-traversed",
		edge,
		count,
		stage,
		lines,
		context,
	});
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runBestEffortWorkflowCleanup(options: {
	tempDir: string;
	runWorkspace?: ManagedWorkspace;
	onUpdate?: WorkflowOptions["onUpdate"];
	stage: "complete" | "failed";
}): Promise<void> {
	const cleanupFailures: string[] = [];
	if (options.tempDir) {
		try {
			await rm(options.tempDir, { recursive: true, force: true });
		} catch (error) {
			cleanupFailures.push(`Failed to remove workflow temp dir ${options.tempDir}: ${formatErrorMessage(error)}`);
		}
	}
	if (options.runWorkspace) {
		try {
			await options.runWorkspace.cleanup();
		} catch (error) {
			cleanupFailures.push(
				`Failed to clean up isolated workspace ${options.runWorkspace.cwd}: ${formatErrorMessage(error)}`,
			);
		}
	}
	if (cleanupFailures.length === 0) return;
	try {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: options.stage,
			lines: ["Best-effort workflow cleanup reported issues:", ...cleanupFailures.map((message) => `- ${message}`)],
			context: {
				note: "Workflow cleanup reported issues",
			},
		});
	} catch {
		// Cleanup reporting must stay best-effort too so it never overrides the workflow outcome.
	}
}

async function writeChildConflictReferenceFiles(options: {
	tempDir: string;
	prefix: string;
	childCwd: string;
	files: string[];
}): Promise<string[]> {
	const references: string[] = [];
	for (const file of options.files) {
		const sourcePath = join(options.childCwd, file);
		const destinationPath = join(
			options.tempDir,
			"conflicts",
			options.prefix,
			file.replace(/[\\:]/g, "_").replace(/^\/+/, ""),
		);
		try {
			await mkdir(dirname(destinationPath), { recursive: true });
			await copyFile(sourcePath, destinationPath);
			references.push(destinationPath);
		} catch {
			// If the file was deleted in the child workspace, skip the copy and describe it in markdown only.
		}
	}
	return references;
}

async function resolveWorkspaceIntegrationConflicts(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	phase: DecompositionPhase;
	childWorkspace: ManagedWorkspace;
	baseline: WorkspaceSnapshot;
	conflictingFiles: string[];
	model?: string;
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
}): Promise<string> {
	const childReferenceFiles = await writeChildConflictReferenceFiles({
		tempDir: options.tempDir,
		prefix: options.phase.id,
		childCwd: options.childWorkspace.cwd,
		files: options.conflictingFiles,
	});
	const promptSelection = pickRemediationPrompt({
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		phases: [options.phase],
		changedFiles: options.conflictingFiles,
	});
	const baselineLines = options.conflictingFiles.map((file) => {
		const baselineHash = options.baseline.files[file];
		return `- ${file}${baselineHash === null ? " (did not exist in the parent when the child workspace started)" : ""}`;
	});
	const contextMarkdown = trimBlock(
		[
			"## Workspace integration conflicts",
			"",
			`Phase: ${options.phase.id} — ${options.phase.title}`,
			"",
			"The parent workspace already changed these files after the child workspace forked.",
			"Resolve the conflicts in the current parent workspace by integrating the child workspace intent without regressing the already-integrated parent state.",
			"Review the attached child-version files for the incoming implementation before editing the parent files.",
			"",
			"## Conflicting files",
			"",
			...baselineLines,
			"",
			"## Child-version reference files",
			"",
			...(childReferenceFiles.length > 0 ? childReferenceFiles.map((file) => `- ${file}`) : ["- Some child files were deleted; inspect the parent workspace and current diffs directly."]),
		].join("\n"),
	);
	if (options.onUpdate) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "fix",
			lines: [
				`Resolving ${options.conflictingFiles.length} workspace integration conflict(s).`,
				`Worker: ${promptSelection.promptLabel}`,
			],
			context: {
				changedFiles: options.conflictingFiles,
				changedFilesSummary: summarizePaths(options.conflictingFiles),
				workerKind: promptSelection.kind,
				note: promptSelection.reason,
			},
		});
	}
	return await runWorkerFixPass({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: uniquePaths([...options.agentFiles, ...childReferenceFiles]),
		touchedPaths: options.conflictingFiles,
		systemPrompt: promptSelection.systemPrompt,
		contextTitle: `${options.phase.id}-workspace-conflicts`,
		contextMarkdown,
		prompt:
			"Resolve the attached workspace integration conflicts now. Work in the current parent workspace, compare it against the attached child-version files, keep the result minimal, preserve already-integrated work, and then summarize what you resolved.",
		model: options.model,
		thinkingLevel: options.thinkingLevel,
	});
}

function ensureSuccessfulSubagent(stage: string, result: Awaited<ReturnType<typeof runSubagent>>): string {
	const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	if (failed) {
		const detail = result.errorMessage || result.stderr || result.assistantText || `${stage} failed with exit code ${result.exitCode}`;
		throw new Error(`${stage} failed: ${detail}`);
	}
	return result.assistantText.trim();
}

async function runStructuredStage<T>(options: {
	name: string;
	systemPrompt: string;
	prompt: string;
	files: string[];
	tools: string[];
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	tempDir: string;
	onUsage?: (usage: SubagentUsageTotals) => void;
	parse: (text: string) => T;
}): Promise<T> {
	const first = await runSubagent({
		cwd: options.cwd,
		systemPrompt: options.systemPrompt,
		prompt: options.prompt,
		files: options.files,
		tools: options.tools,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		onUsage: forwardWorkflowSubagentUsage,
	});
	const firstText = ensureSuccessfulSubagent(options.name, first);
	try {
		return options.parse(firstText);
	} catch (error) {
		const retryInputPath = await writeTempContextFile(
			options.tempDir,
			`${options.name.replace(/\W+/g, "-")}-retry-input.md`,
			[
				"## Previous invalid output",
				"",
				firstText || "(empty)",
				"",
				"## Parse error",
				"",
				error instanceof Error ? error.message : String(error),
			].join("\n"),
		);
		const retry = await runSubagent({
			cwd: options.cwd,
			systemPrompt: options.systemPrompt,
			prompt: `${options.prompt}\n\nYour previous response was not valid for the required JSON shape. Return only corrected JSON.`,
			files: [...options.files, retryInputPath],
			tools: options.tools,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			onUsage: forwardWorkflowSubagentUsage,
		});
		const retryText = ensureSuccessfulSubagent(`${options.name} retry`, retry);
		return options.parse(retryText);
	}
}

function textSuggestsDesignSensitivity(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	return DESIGN_TEXT_PATTERN.test(normalized);
}

function pathsSuggestDesignSensitivity(paths: string[]): boolean {
	return paths.some((path) => {
		const normalized = path.trim().replace(/\\/g, "/");
		if (!normalized) return false;
		return DESIGN_FILE_EXTENSION_PATTERN.test(normalized) || DESIGN_PATH_PATTERN.test(normalized);
	});
}

function findingLooksDesignSensitive(finding: CheckerReport["findings"][number]): boolean {
	if (finding.category === "ui") return true;
	if (pathsSuggestDesignSensitivity(finding.paths)) return true;
	return textSuggestsDesignSensitivity([finding.summary, finding.details, finding.suggestedFix].join("\n"));
}

function phaseDesignSensitivityReason(phase: DecompositionPhase): string | null {
	if (phase.designSensitive) return `phase ${phase.id} is marked designSensitive`;
	if (pathsSuggestDesignSensitivity(phase.touchedPaths)) return `phase ${phase.id} touches UI or interaction-related paths`;
	if (phase.touchedPaths.length === 0 && textSuggestsDesignSensitivity([phase.title, phase.goal, ...phase.instructions].join("\n"))) {
		return `phase ${phase.id} has no concrete paths yet but describes UI, discoverability, or product-behavior work`;
	}
	return null;
}

function detectDesignSensitivityReason(options: {
	phase?: DecompositionPhase;
	phases?: DecompositionPhase[];
	changedFiles?: string[];
	discrepancyText?: string;
	findings?: CheckerReport["findings"];
}): string | null {
	if (options.phase) {
		const phaseReason = phaseDesignSensitivityReason(options.phase);
		if (phaseReason) return phaseReason;
	}
	for (const phase of options.phases ?? []) {
		const phaseReason = phaseDesignSensitivityReason(phase);
		if (phaseReason) return phaseReason;
	}
	if (pathsSuggestDesignSensitivity(options.changedFiles ?? [])) {
		return "changed files indicate UI or interaction work";
	}
	if (textSuggestsDesignSensitivity(options.discrepancyText ?? "")) {
		return "validator discrepancy text indicates UI or product-behavior work";
	}
	const designFinding = options.findings?.find((finding) => findingLooksDesignSensitive(finding));
	if (designFinding) {
		return designFinding.category === "ui"
			? "review findings include UI or discoverability issues"
			: "review findings reference interaction, hierarchy, or product-behavior concerns";
	}
	return null;
}

function makePromptSelection(
	kind: WorkerPromptKind,
	systemPrompt: string,
	designSensitive: boolean,
	reason: string,
): WorkerPromptSelection {
	return {
		kind,
		systemPrompt,
		designSensitive,
		reason,
		promptLabel: kind === "design-worker" ? "Design specialist" : "Implementation worker",
	};
}

export function shouldRunDesignReview(options: {
	phases?: DecompositionPhase[];
	changedFiles?: string[];
	discrepancyText?: string;
	findings?: CheckerReport["findings"];
}): boolean {
	return Boolean(
		detectDesignSensitivityReason({
			phases: options.phases,
			changedFiles: options.changedFiles,
			discrepancyText: options.discrepancyText,
			findings: options.findings,
		}),
	);
}

export function pickWorkerPromptForPhase(
	phase: DecompositionPhase,
	prompts: { workerPrompt: string; designWorkerPrompt: string },
): WorkerPromptSelection {
	const reason = detectDesignSensitivityReason({ phase });
	if (reason) return makePromptSelection("design-worker", prompts.designWorkerPrompt, true, reason);
	return makePromptSelection("worker", prompts.workerPrompt, false, "phase is not design-sensitive");
}

export function pickRemediationPrompt(options: {
	workerPrompt: string;
	designWorkerPrompt: string;
	phases?: DecompositionPhase[];
	changedFiles?: string[];
	findings?: CheckerReport["findings"];
	discrepancyText?: string;
}): WorkerPromptSelection {
	const reason = detectDesignSensitivityReason({
		phases: options.phases,
		changedFiles: options.changedFiles,
		findings: options.findings,
		discrepancyText: options.discrepancyText,
	});
	if (reason) return makePromptSelection("design-worker", options.designWorkerPrompt, true, reason);
	return makePromptSelection("worker", options.workerPrompt, false, "remediation is code-focused without design-sensitive signals");
}

function classifyQualityGateFinding(
	stage: QualityStageId,
	finding: CheckerReport["findings"][number],
): QualityGateClassification {
	if (finding.category === "security" || finding.category === "regression" || finding.category === "guidance") {
		return "hard";
	}
	if (stage === "design" && finding.severity === "high") return "hard";
	if (finding.severity === "high") return "hard";
	return "soft";
}

function summarizeQualityGateFinding(
	stage: QualityStageId,
	finding: CheckerReport["findings"][number],
): QualityGateFindingSummary {
	return {
		stage,
		category: finding.category,
		severity: finding.severity,
		summary: finding.summary,
		paths: [...finding.paths],
		classification: classifyQualityGateFinding(stage, finding),
	};
}

function partitionQualityGateFindings(
	stage: QualityStageId,
	findings: CheckerReport["findings"],
): { hard: QualityGateFindingSummary[]; soft: QualityGateFindingSummary[] } {
	const hard: QualityGateFindingSummary[] = [];
	const soft: QualityGateFindingSummary[] = [];
	for (const finding of findings) {
		const summary = summarizeQualityGateFinding(stage, finding);
		if (summary.classification === "hard") hard.push(summary);
		else soft.push(summary);
	}
	return { hard, soft };
}

function buildQualityRoundSnapshot(options: {
	round: number;
	hardGateFindings: QualityGateFindingSummary[];
	softGateFindings: QualityGateFindingSummary[];
}): QualitySuiteRoundSnapshot {
	const weightedScore =
		options.hardGateFindings.reduce((sum, finding) => sum + 20 + severityRank(finding.severity), 0) +
		options.softGateFindings.reduce((sum, finding) => sum + severityRank(finding.severity), 0);
	return {
		round: options.round,
		hardFindingCount: options.hardGateFindings.length,
		softFindingCount: options.softGateFindings.length,
		totalFindingCount: options.hardGateFindings.length + options.softGateFindings.length,
		weightedScore,
	};
}

function isMaterialQualityProgress(previous: QualitySuiteRoundSnapshot, current: QualitySuiteRoundSnapshot): boolean {
	if (current.hardFindingCount < previous.hardFindingCount) return true;
	if (current.weightedScore < previous.weightedScore && current.hardFindingCount <= previous.hardFindingCount) {
		return true;
	}
	if (current.totalFindingCount < previous.totalFindingCount && current.hardFindingCount <= previous.hardFindingCount) {
		return true;
	}
	return false;
}

function countConsecutiveQualityStagnation(
	history: QualitySuiteRoundSnapshot[],
	current: QualitySuiteRoundSnapshot,
): number {
	const snapshots = [...history, current];
	let count = 0;
	for (let index = snapshots.length - 1; index > 0; index--) {
		if (isMaterialQualityProgress(snapshots[index - 1]!, snapshots[index]!)) break;
		count += 1;
	}
	return count;
}

function renderQualityGateCountsSummary(findings: QualityGateFindingSummary[]): string {
	if (findings.length === 0) return "none";
	const byStage = new Map<QualityStageId, number>();
	for (const finding of findings) {
		byStage.set(finding.stage, (byStage.get(finding.stage) ?? 0) + 1);
	}
	return Array.from(byStage.entries())
		.map(([stage, count]) => `${stage} ${count}`)
		.join(", ");
}

export function decideQualitySuiteRound(options: {
	round: number;
	maxRounds: number;
	extraRounds?: number;
	history?: QualitySuiteRoundSnapshot[];
	cleanupReport: CheckerReport;
	designRequired: boolean;
	designReport?: CheckerReport | null;
	checkerReport: CheckerReport;
}): QualitySuiteRoundDecision {
	const extraRounds = options.extraRounds ?? QUALITY_SUITE_MAX_EXTRA_ROUNDS;
	const roundBudget = {
		base: options.maxRounds,
		extra: extraRounds,
		total: options.maxRounds + extraRounds,
	};
	const findingCounts: Record<QualityStageId, number> = {
		cleanup: options.cleanupReport.findings.length,
		design: options.designRequired ? (options.designReport?.findings.length ?? 0) : 0,
		checker: options.checkerReport.findings.length,
	};
	const triggerStages: QualityStageId[] = [];
	if (findingCounts.cleanup > 0) triggerStages.push("cleanup");
	if (options.designRequired && findingCounts.design > 0) triggerStages.push("design");
	if (findingCounts.checker > 0) triggerStages.push("checker");

	const hardFindingCounts: Record<QualityStageId, number> = { cleanup: 0, design: 0, checker: 0 };
	const softFindingCounts: Record<QualityStageId, number> = { cleanup: 0, design: 0, checker: 0 };
	const hardGateFindings: QualityGateFindingSummary[] = [];
	const softGateFindings: QualityGateFindingSummary[] = [];
	const reportsByStage: Array<[QualityStageId, CheckerReport["findings"]]> = [
		["cleanup", options.cleanupReport.findings],
		["checker", options.checkerReport.findings],
	];
	if (options.designRequired) reportsByStage.splice(1, 0, ["design", options.designReport?.findings ?? []]);
	for (const [stage, findings] of reportsByStage) {
		for (const finding of findings) {
			const summary = summarizeQualityGateFinding(stage, finding);
			if (summary.classification === "hard") {
				hardFindingCounts[stage] += 1;
				hardGateFindings.push(summary);
			} else {
				softFindingCounts[stage] += 1;
				softGateFindings.push(summary);
			}
		}
	}

	const snapshot = buildQualityRoundSnapshot({
		round: options.round,
		hardGateFindings,
		softGateFindings,
	});
	const previousSnapshot = options.history?.[options.history.length - 1];
	const materialProgress = previousSnapshot ? isMaterialQualityProgress(previousSnapshot, snapshot) : false;
	const stagnationCount = countConsecutiveQualityStagnation(options.history ?? [], snapshot);
	const designReviewStatus = options.designRequired ? "ran" : "skipped";
	if (triggerStages.length === 0) {
		return {
			action: "pass",
			designReviewStatus,
			triggerStages,
			findingCounts,
			hardFindingCounts,
			softFindingCounts,
			hardGateFindings,
			softGateFindings,
			materialProgress,
			stagnationCount,
			roundBudget,
			snapshot,
		};
	}

	if (options.round < options.maxRounds) {
		return {
			action: "remediate",
			designReviewStatus,
			triggerStages,
			findingCounts,
			hardFindingCounts,
			softFindingCounts,
			hardGateFindings,
			softGateFindings,
			materialProgress,
			stagnationCount,
			roundBudget,
			snapshot,
			restartStage: "cleanup",
		};
	}

	if (hardGateFindings.length > 0) {
		if (options.round < roundBudget.total && materialProgress) {
			return {
				action: "remediate",
				designReviewStatus,
				triggerStages,
				findingCounts,
				hardFindingCounts,
				softFindingCounts,
				hardGateFindings,
				softGateFindings,
				materialProgress,
				stagnationCount,
				roundBudget,
				snapshot,
				restartStage: "cleanup",
				message: `Extending the quality suite beyond ${options.maxRounds} round(s) because hard findings are still improving materially.`,
			};
		}
		const stagnationNote =
			stagnationCount >= QUALITY_SUITE_STAGNATION_LIMIT
				? ` Findings have not materially improved for ${stagnationCount} consecutive round transition(s).`
				: "";
		return {
			action: "fail",
			designReviewStatus,
			triggerStages,
			findingCounts,
			hardFindingCounts,
			softFindingCounts,
			hardGateFindings,
			softGateFindings,
			materialProgress,
			stagnationCount,
			roundBudget,
			snapshot,
			message: `Quality suite stopped after ${options.round} round(s). Hard-blocking findings remain: ${renderQualityGateCountsSummary(hardGateFindings)}.${stagnationNote}`,
		};
	}

	if (options.round < roundBudget.total && materialProgress) {
		return {
			action: "remediate",
			designReviewStatus,
			triggerStages,
			findingCounts,
			hardFindingCounts,
			softFindingCounts,
			hardGateFindings,
			softGateFindings,
			materialProgress,
			stagnationCount,
			roundBudget,
			snapshot,
			restartStage: "cleanup",
			message: `Only soft quality findings remain, and the latest round improved materially, so the suite gets another pass (${options.round + 1}/${roundBudget.total}).`,
		};
	}

	return {
		action: "prompt",
		designReviewStatus,
		triggerStages,
		findingCounts,
		hardFindingCounts,
		softFindingCounts,
		hardGateFindings,
		softGateFindings,
		materialProgress,
		stagnationCount,
		roundBudget,
		snapshot,
		message:
			`Only soft quality findings remain after ${options.round} round(s): ${renderQualityGateCountsSummary(softGateFindings)}. ` +
			"Choose whether to accept the remaining polish issues, continue remediation anyway, or reformulate in discovery mode.",
	};
}

function createWorkflowQualityStats(): WorkflowQualityStats {
	return {
		cleanupRuns: 0,
		designReviewRuns: 0,
		designReviewSkips: 0,
		checkerRuns: 0,
		remediationPasses: 0,
		fixedFindingSignatures: {
			cleanup: new Set<string>(),
			design: new Set<string>(),
			checker: new Set<string>(),
		},
		agentsCheckResults: [],
		pendingLegacyCleanupFindingSignatures: new Set<string>(),
		legacyCodeOrFilesRemoved: false,
		mergedResultVerificationRuns: 0,
		mergedResultVerificationReasons: new Set<string>(),
	};
}

function findingSignature(stage: QualityStageId, finding: CheckerReport["findings"][number]): string {
	return [stage, finding.category, finding.summary.trim().toLowerCase(), [...finding.paths].sort().join(",")].join("|");
}

function recordQualityFindings(stats: WorkflowQualityStats, stage: QualityStageId, findings: CheckerReport["findings"]): void {
	for (const finding of findings) {
		stats.fixedFindingSignatures[stage].add(findingSignature(stage, finding));
	}
}

function findingSuggestsLegacyCleanup(finding: CheckerReport["findings"][number]): boolean {
	return LEGACY_CLEANUP_PATTERN.test([finding.summary, finding.details, finding.suggestedFix].join("\n"));
}

function legacyCleanupFindingSignatures(findings: CheckerReport["findings"]): Set<string> {
	return new Set(
		findings
			.filter((finding) => findingSuggestsLegacyCleanup(finding))
			.map((finding) => {
				const normalizedPaths = [...finding.paths].sort().join(",");
				return normalizedPaths ? `${finding.category}|${normalizedPaths}` : null;
			})
			.filter((signature): signature is string => Boolean(signature)),
	);
}

function hasResolvedLegacyCleanupSignatures(previous: Set<string>, current: Set<string>): boolean {
	for (const signature of previous) {
		if (!current.has(signature)) return true;
	}
	return false;
}

export function hasVerifiedLegacyCleanupRemoval(options: {
	previousFindings: CheckerReport["findings"];
	currentFindings: CheckerReport["findings"];
}): boolean {
	return hasResolvedLegacyCleanupSignatures(
		legacyCleanupFindingSignatures(options.previousFindings),
		legacyCleanupFindingSignatures(options.currentFindings),
	);
}

function updateLegacyCleanupEvidence(stats: WorkflowQualityStats, findings: CheckerReport["findings"]): void {
	const currentLegacyCleanupSignatures = legacyCleanupFindingSignatures(findings);
	if (
		hasResolvedLegacyCleanupSignatures(
			stats.pendingLegacyCleanupFindingSignatures,
			currentLegacyCleanupSignatures,
		)
	) {
		stats.legacyCodeOrFilesRemoved = true;
	}
	stats.pendingLegacyCleanupFindingSignatures = currentLegacyCleanupSignatures;
}

function mergeWorkflowQualityStats(target: WorkflowQualityStats, incoming: WorkflowQualityStats): void {
	target.cleanupRuns += incoming.cleanupRuns;
	target.designReviewRuns += incoming.designReviewRuns;
	target.designReviewSkips += incoming.designReviewSkips;
	target.checkerRuns += incoming.checkerRuns;
	target.remediationPasses += incoming.remediationPasses;
	for (const stage of ["cleanup", "design", "checker"] as const) {
		for (const signature of incoming.fixedFindingSignatures[stage]) {
			target.fixedFindingSignatures[stage].add(signature);
		}
	}
	target.agentsCheckResults.push(...incoming.agentsCheckResults);
	target.legacyCodeOrFilesRemoved ||= incoming.legacyCodeOrFilesRemoved;
	target.mergedResultVerificationRuns += incoming.mergedResultVerificationRuns;
	for (const reason of incoming.mergedResultVerificationReasons) {
		target.mergedResultVerificationReasons.add(reason);
	}
}

function summarizeWorkflowQualityStats(stats: WorkflowQualityStats): WorkflowQualitySummary {
	const cleanup = stats.fixedFindingSignatures.cleanup.size;
	const design = stats.fixedFindingSignatures.design.size;
	const checker = stats.fixedFindingSignatures.checker.size;
	return {
		cleanupRuns: stats.cleanupRuns,
		designReviewRuns: stats.designReviewRuns,
		designReviewSkips: stats.designReviewSkips,
		checkerRuns: stats.checkerRuns,
		remediationPasses: stats.remediationPasses,
		fixedFindings: {
			cleanup,
			design,
			checker,
			total: cleanup + design + checker,
		},
		agentsChecks: summarizeAgentsCheckHistory(stats.agentsCheckResults),
		legacyCodeOrFilesRemoved: stats.legacyCodeOrFilesRemoved,
		mergedResultVerificationRuns: stats.mergedResultVerificationRuns,
		mergedResultVerificationReasons: [...stats.mergedResultVerificationReasons].sort(),
	};
}

function emptyCheckerReport(): CheckerReport {
	return {
		findings: [],
		checksRun: [],
		unresolvedRisks: [],
		overallAssessment: "Looks good",
	};
}

interface RequiredChecksPassResult {
	guidance: RelevantGuidanceResult;
	commands: AgentsCheckCommand[];
	results: CheckRunSummary[];
	report: CheckerReport;
}

async function runRequiredChecksPass(options: {
	cwd: string;
	changedFiles: string[];
	exec: ExecLike;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
}): Promise<RequiredChecksPassResult> {
	const guidance = discoverRelevantGuidance(options.cwd, options.changedFiles, "AGENTS.md");
	const commands = collectAgentsCheckCommands(guidance.documents);
	const policy =
		commands.length > 0
			? await (options.resolveAgentsCheckExecutionPolicy?.(commands) ?? Promise.resolve({ allowed: true }))
			: { allowed: true };
	if (commands.length > 0) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "checker",
			lines: [
				policy.allowed
					? `Running ${commands.length} early AGENTS.md-required check command(s).`
					: `Blocking ${commands.length} early AGENTS.md-required check command(s).`,
				...summarizeAgentsCheckCommands(commands, 3),
				...(policy.allowed || !policy.reason ? [] : [policy.reason]),
			],
			context: {
				changedFiles: options.changedFiles,
				changedFilesSummary: summarizePaths(options.changedFiles),
				note: policy.allowed ? "Running early AGENTS.md-required checks" : "Early AGENTS.md checks blocked",
			},
		});
	}
	const runs = await runAgentsCheckCommands({
		cwd: options.cwd,
		exec: options.exec,
		commands,
		policy,
	});
	const results = runs.map((run) => ({
		command: run.command,
		source: run.source,
		status: run.status,
		summary: run.summary,
	} satisfies CheckRunSummary));
	const report = appendAgentsChecksToCheckerReport(emptyCheckerReport(), runs);
	return { guidance, commands, results, report };
}

async function prepareReviewContextFiles(options: {
	cwd: string;
	tempDir: string;
	prefix: string;
	planPath: string;
	agentFiles: string[];
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
}): Promise<{ guidance: RelevantGuidanceResult; files: string[] }> {
	const guidance = discoverRelevantGuidance(options.cwd, options.changedFiles, "AGENTS.md");
	const sanitizedPrefix = options.prefix.replace(/\W+/g, "-");
	const decompositionPath = await writeTempContextFile(
		options.tempDir,
		`${sanitizedPrefix}-decomposition.md`,
		renderDecompositionSummary(options.decomposition),
	);
	const workerSummaryPath = await writeTempContextFile(
		options.tempDir,
		`${sanitizedPrefix}-worker-summaries.md`,
		renderWorkerPhaseSummaries(options.workerResults),
	);
	const changedFilesPath = await writeTempContextFile(
		options.tempDir,
		`${sanitizedPrefix}-changed-files.md`,
		renderChangedFilesSummary(options.changedFiles),
	);
	const guidancePath = await writeTempContextFile(
		options.tempDir,
		`${sanitizedPrefix}-agents-guidance.md`,
		renderRelevantGuidanceSummary(guidance),
	);
	return {
		guidance,
		files: [
			...new Set([
				options.planPath,
				...options.agentFiles,
				...guidance.documents.map((document) => document.path),
				decompositionPath,
				workerSummaryPath,
				changedFilesPath,
				guidancePath,
			]),
		],
	};
}

function summarizeSingleModelReview(
	report: CheckerReport,
	fallbackCommand: string,
	fallbackSource: string,
): CheckRunSummary {
	const check = report.checksRun[0];
	const checkStatus = check?.status;
	const status =
		report.findings.length > 0
			? "failed"
			: checkStatus === "blocked" || checkStatus === "error" || checkStatus === "failed"
				? checkStatus
				: "passed";
	return {
		command: check?.command || fallbackCommand,
		source: check?.source || fallbackSource,
		status,
		summary: check?.summary || report.overallAssessment || `${report.findings.length} finding(s)`,
	};
}

async function runSpecialistReview(options: {
	name: string;
	prefix: string;
	reviewCommand: string;
	systemPrompt: string;
	prompt: string;
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	model?: string;
	thinkingLevel?: string;
}): Promise<SpecialistReviewRun> {
	const context = await prepareReviewContextFiles({
		cwd: options.cwd,
		tempDir: options.tempDir,
		prefix: options.prefix,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		decomposition: options.decomposition,
		workerResults: options.workerResults,
		changedFiles: options.changedFiles,
	});
	const report = await runStructuredStage({
		name: options.name,
		systemPrompt: options.systemPrompt,
		prompt: options.prompt,
		files: context.files,
		tools: READ_ONLY_SUBAGENT_TOOLS,
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tempDir: options.tempDir,
		parse: parseCheckerReport,
	});
	return {
		report,
		guidance: context.guidance,
		summary: summarizeSingleModelReview(report, options.reviewCommand, options.model ?? "default"),
	};
}

async function runWorkerPhase(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	phase: DecompositionPhase;
	batchIndex: number;
	batchCount: number;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
}): Promise<WorkerPhaseResult> {
	const promptSelection = pickWorkerPromptForPhase(options.phase, {
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
	});
	const phaseContextPath = await writeTempContextFile(
		options.tempDir,
		`${options.phase.id.replace(/\W+/g, "-")}.md`,
		[
			"## Assigned implementation phase",
			"",
			`- id: ${options.phase.id}`,
			`- title: ${options.phase.title}`,
			`- goal: ${options.phase.goal}`,
			`- dependsOn: ${options.phase.dependsOn.length > 0 ? options.phase.dependsOn.join(", ") : "none"}`,
			`- touchedPaths: ${options.phase.touchedPaths.length > 0 ? options.phase.touchedPaths.join(", ") : "unknown"}`,
			`- designSensitive: ${options.phase.designSensitive ? "yes" : "no"}`,
			`- selectedWorker: ${promptSelection.promptLabel}`,
			`- workerReason: ${promptSelection.reason}`,
			"",
			"## Instructions",
			"",
			...options.phase.instructions.map((instruction) => `- ${instruction}`),
			...(options.extraInstructions.trim() ? ["", "## Additional instructions", "", options.extraInstructions.trim()] : []),
		].join("\n"),
	);

	emitWorkflowUpdate(options.onUpdate, {
		type: "phase-started",
		phaseId: options.phase.id,
		stage: `worker:${options.phase.id}`,
		lines: [
			`Implementing ${options.phase.title}`,
			`Batch ${options.batchIndex + 1}/${options.batchCount} • Touched paths: ${summarizePaths(options.phase.touchedPaths)}`,
			`Worker: ${promptSelection.promptLabel}`,
		],
		context: {
			batchIndex: options.batchIndex,
			batchCount: options.batchCount,
			phaseId: options.phase.id,
			phaseTitle: options.phase.title,
			touchedPaths: options.phase.touchedPaths,
			touchedPathsSummary: summarizePaths(options.phase.touchedPaths),
			workerKind: promptSelection.kind,
			note: promptSelection.reason,
		},
	});

	const phaseAgentFiles = collectWorkerAgentFiles(options.agentFiles, options.cwd, options.phase.touchedPaths, [phaseContextPath]);
	const result = await runSubagent({
		cwd: options.cwd,
		systemPrompt: promptSelection.systemPrompt,
		prompt: "Implement the assigned phase now. Read the attached plan and phase brief, inspect the relevant files, make the code changes, and then summarize what you completed.",
		files: [options.planPath, ...phaseAgentFiles],
		tools: WORKER_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		onUsage: forwardWorkflowSubagentUsage,
	});

	const summary = ensureSuccessfulSubagent(`worker ${options.phase.id}`, result);
	emitWorkflowUpdate(options.onUpdate, {
		type: "phase-completed",
		phaseId: options.phase.id,
		stage: `worker:${options.phase.id}`,
		lines: [
			`Completed ${options.phase.title}`,
			`Batch ${options.batchIndex + 1}/${options.batchCount} • Touched paths: ${summarizePaths(options.phase.touchedPaths)}`,
			`Worker: ${promptSelection.promptLabel}`,
		],
		context: {
			batchIndex: options.batchIndex,
			batchCount: options.batchCount,
			phaseId: options.phase.id,
			phaseTitle: options.phase.title,
			touchedPaths: options.phase.touchedPaths,
			touchedPathsSummary: summarizePaths(options.phase.touchedPaths),
			workerKind: promptSelection.kind,
			note: promptSelection.reason,
		},
	});
	return {
		phase: {
			...options.phase,
			designSensitive: promptSelection.designSensitive || options.phase.designSensitive,
		},
		summary,
	};
}

async function runWorkerFixPass(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	touchedPaths: string[];
	systemPrompt: string;
	contextTitle: string;
	contextMarkdown: string;
	prompt: string;
	model?: string;
	thinkingLevel?: string;
}): Promise<string> {
	const contextPath = await writeTempContextFile(
		options.tempDir,
		`${options.contextTitle.replace(/\W+/g, "-")}.md`,
		options.contextMarkdown,
	);
	const fixAgentFiles = collectWorkerAgentFiles(options.agentFiles, options.cwd, options.touchedPaths, [contextPath]);
	const result = await runSubagent({
		cwd: options.cwd,
		systemPrompt: options.systemPrompt,
		prompt: options.prompt,
		files: [options.planPath, ...fixAgentFiles],
		tools: WORKER_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		onUsage: forwardWorkflowSubagentUsage,
	});
	return ensureSuccessfulSubagent(options.contextTitle, result);
}

function createFastModeDecomposition(planText: string): DecompositionPlan {
	const designSensitive = textSuggestsDesignSensitivity(planText);
	return {
		phases: [
			{
				id: "implementation",
				title: "Implement approved plan",
				goal: "Deliver the approved plan as one coherent change in the isolated workspace.",
				instructions: [
					"Read PLAN.md, inspect the relevant files, and implement the approved plan end-to-end as one coherent change.",
					"Prefer the smallest complete slice that satisfies the plan instead of broad speculative refactors.",
					"Use bash for focused repo inspection and verification inside the isolated workspace when it helps you catch issues before handing off.",
				],
				dependsOn: [],
				touchedPaths: [],
				parallelSafe: false,
				designSensitive,
			},
		],
		notes: [
			"Fast mode skips explicit decomposition and specialist review layers unless the user later asks for strict mode.",
		],
	};
}

async function runFastImplementationWorkflow(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	checkerPrompt: string;
	validatorPrompt: string;
	extraInstructions: string;
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
	promptForHardGateChoice?: (decision: FinalCheckerHardGateDecision) => Promise<FinalCheckerHardGateChoice>;
}): Promise<{
	decision: Extract<WorkflowDecision, "done" | "stopped">;
	summary: string;
	decomposition?: DecompositionPlan;
	workerResults?: WorkerPhaseResult[];
}> {
	const workflowQualityStats = createWorkflowQualityStats();
	workflowQualityStats.mergedResultVerificationRuns += 1;
	workflowQualityStats.mergedResultVerificationReasons.add("fast isolated implementation result");
	const planText = await readFile(options.planPath, "utf8");
	const decomposition = createFastModeDecomposition(planText);

	options.onStageChange?.("decomposer");
	emitWorkflowUpdate(options.onUpdate, {
		type: "decomposer-started",
		stage: "decomposer",
		lines: [
			"Fast mode selected: skipping explicit decomposition and preparing one whole-plan implementation phase.",
			`Primary model: ${options.primaryModel ?? "default"}`,
		],
		context: {
			checkerModels: options.checkerModels,
			note: "Fast-mode phase preparation started",
		},
	});
	emitWorkflowUpdate(options.onUpdate, {
		type: "decomposer-completed",
		phases: decomposition.phases,
		stage: "decomposer",
		lines: [
			"Fast mode prepared a single whole-plan implementation phase.",
			decomposition.notes[0] ?? "Fast mode uses one implementation phase.",
		],
		context: {
			phaseCount: decomposition.phases.length,
			note: "Fast-mode phase preparation completed",
		},
	});
	const batches = computeExecutionBatches(decomposition.phases);
	emitWorkflowUpdate(options.onUpdate, {
		type: "batches-computed",
		phases: decomposition.phases,
		batches,
		stage: "implementation",
		lines: ["Prepared 1 implementation batch in fast mode.", "Batch 1: Implement approved plan"],
		context: {
			batchCount: batches.length,
			phaseCount: decomposition.phases.length,
			note: "Fast-mode implementation batch ready",
		},
	});

	const workerResults: WorkerPhaseResult[] = [];
	options.onStageChange?.("implementation");
	const phaseResult = await runWorkerPhase({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		phase: decomposition.phases[0]!,
		batchIndex: 0,
		batchCount: 1,
		extraInstructions: options.extraInstructions,
		model: options.primaryModel,
		thinkingLevel: options.thinkingLevel,
		onUpdate: options.onUpdate,
	});
	workerResults.push(phaseResult);
	let changedFiles = await detectChangedFiles(options.cwd, options.exec);

	let earlyChecks = await runRequiredChecksPass({
		cwd: options.cwd,
		changedFiles,
		exec: options.exec,
		onUpdate: options.onUpdate,
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
	});
	workflowQualityStats.agentsCheckResults.push(...earlyChecks.results);
	if (earlyChecks.report.findings.length > 0) {
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: workerResults.map((result) => result.phase),
			changedFiles,
			findings: earlyChecks.report.findings,
		});
		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				"Early required checks found blocking issues. Applying one focused remediation pass before final review.",
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles,
				changedFilesSummary: summarizePaths(changedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: earlyChecks.guidance.documents.map((document) => document.path).length > 0
				? [...new Set([...options.agentFiles, ...earlyChecks.guidance.documents.map((document) => document.path)])]
				: options.agentFiles,
			touchedPaths: changedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: "fast-precheck-fix",
			contextMarkdown: renderFindingReportSummary("Early AGENTS.md-required check findings", earlyChecks.report),
			prompt:
				"Resolve the attached failed or blocked AGENTS.md-required checks now. Make the smallest code changes needed to clear them, run focused verification if useful, and then summarize what changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		workerResults.push({
			phase: {
				id: "fast-precheck-fix",
				title: "Early required-check remediation",
				goal: "Resolve blocking AGENTS.md-required checks before final review",
				instructions: ["Resolve the failed or blocked AGENTS.md-required checks before final review."],
				dependsOn: [phaseResult.phase.id],
				touchedPaths: changedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		workflowQualityStats.remediationPasses += 1;
		recordQualityFindings(workflowQualityStats, "checker", earlyChecks.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: ["Completed early required-check remediation.", `Worker: ${remediationPromptSelection.promptLabel}`],
			context: {
				changedFiles,
				changedFilesSummary: summarizePaths(changedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		changedFiles = await detectChangedFiles(options.cwd, options.exec);
		earlyChecks = await runRequiredChecksPass({
			cwd: options.cwd,
			changedFiles,
			exec: options.exec,
			onUpdate: options.onUpdate,
			resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		});
		workflowQualityStats.agentsCheckResults.push(...earlyChecks.results);
		if (earlyChecks.report.findings.length > 0) {
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "checker",
				lines: [
					`Early required checks still report ${earlyChecks.report.findings.length} blocking finding(s).`,
					"Carrying those blockers into the bounded final checker loop so you can decide whether to continue or stop if they remain.",
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					note: "Early required-check blockers still remain",
				},
			});
		}
	}

	const fastCheckerModels = options.primaryModel ? [options.primaryModel] : options.checkerModels.slice(0, 1);
	const checkerModels = fastCheckerModels.length > 0 ? fastCheckerModels : options.checkerModels;
	const checkerLoop = await runCheckerLoop({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		checkerPrompt: options.checkerPrompt,
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		decomposition,
		workerResults,
		changedFiles,
		exec: options.exec,
		primaryModel: options.primaryModel,
		checkerModels,
		thinkingLevel: options.thinkingLevel,
		onUpdate: options.onUpdate,
		onStageChange: options.onStageChange,
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		promptForHardGateChoice: options.promptForHardGateChoice,
	});
	mergeWorkflowQualityStats(workflowQualityStats, checkerLoop.stats);
	changedFiles = checkerLoop.changedFiles;
	const acceptedResidualSoftFindings = checkerLoop.acceptedResidualSoftFindings;
	const blockingHardFindings = checkerLoop.blockingHardFindings;
	const checkPass = checkerLoop.checkerRun;
	if (checkerLoop.outcome === "stopped-hard") {
		return {
			decision: "stopped",
			summary: buildStoppedSummary({
				reason:
					checkerLoop.stopReason ??
					"Final checker stopped with hard-blocking findings still remaining after the bounded retry budget.",
				changedFiles,
				checks: checkPass.results,
				checker: checkPass.report,
				quality: summarizeWorkflowQualityStats(workflowQualityStats),
				workerResults,
				acceptedResidualSoftFindings,
				blockingHardFindings,
			}),
			decomposition,
			workerResults,
		};
	}

	options.onStageChange?.("validator");
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-started",
		stage: "validator",
		lines: [
			"Comparing the fast-mode implementation against PLAN.md.",
			`Changed files: ${summarizePaths(changedFiles)}`,
			`Checker findings: ${checkPass.report.findings.length}`,
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			checkerModels: checkPass.modelRuns.map((run) => run.model),
			note: "Fast-mode validator started",
		},
	});
	const validation = await runValidator({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		validatorPrompt: options.validatorPrompt,
		decomposition,
		workerResults,
		changedFiles,
		checkerReport: checkPass.report,
		checkResults: checkPass.results,
		model: options.primaryModel,
		thinkingLevel: options.thinkingLevel,
	});
	const discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-completed",
		stage: "validator",
		lines: [
			`Validator recommendation: ${validation.recommendation}`,
			validation.summary || `${validation.discrepancies.length} discrepancy(s) reported.`,
			...(discrepancySummaryItems.length > 0 ? [`Discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			discrepancyCount: validation.discrepancies.length,
			discrepancySummary: discrepancySummaryItems,
			recommendation: validation.recommendation,
			note: "Fast-mode validator completed",
		},
	});
	if (validation.discrepancies.length > 0) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "validator",
			lines: [
				`Validator reported ${validation.discrepancies.length} remaining plan discrepancy(s).`,
				"Fast mode stays bounded: remaining discrepancies are reported in the final summary instead of triggering more remediation loops.",
				...(discrepancySummaryItems.length > 0 ? [`Top discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
			],
			context: {
				discrepancyCount: validation.discrepancies.length,
				discrepancySummary: discrepancySummaryItems,
				recommendation: validation.recommendation,
				note: "Fast-mode validator discrepancies recorded for advisory follow-up",
			},
		});
	}

	const summary = buildSummary(
		changedFiles,
		checkPass.results,
		validation,
		checkPass.report,
		summarizeWorkflowQualityStats(workflowQualityStats),
		{
			acceptedResidualSoftFindings,
			blockingHardFindings,
		},
	);
	return {
		decision: "done",
		summary,
	};
}

async function runResumedFastImplementationWorkflow(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	checkerPrompt: string;
	validatorPrompt: string;
	extraInstructions: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
	promptForHardGateChoice?: (decision: FinalCheckerHardGateDecision) => Promise<FinalCheckerHardGateChoice>;
}): Promise<{
	decision: Extract<WorkflowDecision, "done" | "stopped">;
	summary: string;
	workerResults?: WorkerPhaseResult[];
}> {
	const workflowQualityStats = createWorkflowQualityStats();
	workflowQualityStats.mergedResultVerificationRuns += 1;
	workflowQualityStats.mergedResultVerificationReasons.add("resumed fast isolated implementation result");
	let changedFiles = await detectChangedFiles(options.cwd, options.exec);
	const workerResults = options.workerResults;

	emitWorkflowUpdate(options.onUpdate, {
		type: "detail-lines",
		stage: "starting",
		lines: [
			"Resuming the fast sub-agent workflow from the preserved isolated workspace.",
			`Changed files already present: ${summarizePaths(changedFiles)}`,
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			note: "Fast-mode resume started",
		},
	});

	let earlyChecks = await runRequiredChecksPass({
		cwd: options.cwd,
		changedFiles,
		exec: options.exec,
		onUpdate: options.onUpdate,
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
	});
	workflowQualityStats.agentsCheckResults.push(...earlyChecks.results);
	if (earlyChecks.report.findings.length > 0) {
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: workerResults.map((result) => result.phase),
			changedFiles,
			findings: earlyChecks.report.findings,
		});
		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				"Resumed workflow required checks still show blocking issues. Applying one focused remediation pass before final review.",
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles,
				changedFilesSummary: summarizePaths(changedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles:
				earlyChecks.guidance.documents.map((document) => document.path).length > 0
					? [...new Set([...options.agentFiles, ...earlyChecks.guidance.documents.map((document) => document.path)])]
					: options.agentFiles,
			touchedPaths: changedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: "fast-resume-precheck-fix",
			contextMarkdown: renderFindingReportSummary("Early AGENTS.md-required check findings", earlyChecks.report),
			prompt:
				"Resolve the attached failed or blocked AGENTS.md-required checks now. Make the smallest code changes needed to clear them, run focused verification if useful, and then summarize what changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		workerResults.push({
			phase: {
				id: "fast-resume-precheck-fix",
				title: "Resumed required-check remediation",
				goal: "Resolve blocking AGENTS.md-required checks before final review",
				instructions: ["Resolve the failed or blocked AGENTS.md-required checks before final review."],
				dependsOn: workerResults.length > 0 ? [workerResults[workerResults.length - 1]!.phase.id] : [],
				touchedPaths: changedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		workflowQualityStats.remediationPasses += 1;
		recordQualityFindings(workflowQualityStats, "checker", earlyChecks.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: ["Completed resumed required-check remediation.", `Worker: ${remediationPromptSelection.promptLabel}`],
			context: {
				changedFiles,
				changedFilesSummary: summarizePaths(changedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		changedFiles = await detectChangedFiles(options.cwd, options.exec);
		earlyChecks = await runRequiredChecksPass({
			cwd: options.cwd,
			changedFiles,
			exec: options.exec,
			onUpdate: options.onUpdate,
			resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		});
		workflowQualityStats.agentsCheckResults.push(...earlyChecks.results);
		if (earlyChecks.report.findings.length > 0) {
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "checker",
				lines: [
					`Resumed required checks still report ${earlyChecks.report.findings.length} blocking finding(s).`,
					"Carrying those blockers into the bounded final checker loop so you can decide whether to continue or stop if they remain.",
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					note: "Resumed required-check blockers still remain",
				},
			});
		}
	}

	const fastCheckerModels = options.primaryModel ? [options.primaryModel] : options.checkerModels.slice(0, 1);
	const checkerModels = fastCheckerModels.length > 0 ? fastCheckerModels : options.checkerModels;
	const checkerLoop = await runCheckerLoop({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		checkerPrompt: options.checkerPrompt,
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		decomposition: options.decomposition,
		workerResults,
		changedFiles,
		exec: options.exec,
		primaryModel: options.primaryModel,
		checkerModels,
		thinkingLevel: options.thinkingLevel,
		onUpdate: options.onUpdate,
		onStageChange: options.onStageChange,
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		promptForHardGateChoice: options.promptForHardGateChoice,
	});
	mergeWorkflowQualityStats(workflowQualityStats, checkerLoop.stats);
	changedFiles = checkerLoop.changedFiles;
	const acceptedResidualSoftFindings = checkerLoop.acceptedResidualSoftFindings;
	const blockingHardFindings = checkerLoop.blockingHardFindings;
	const checkPass = checkerLoop.checkerRun;
	if (checkerLoop.outcome === "stopped-hard") {
		return {
			decision: "stopped",
			summary: buildStoppedSummary({
				reason:
					checkerLoop.stopReason ??
					"Final checker stopped with hard-blocking findings still remaining after the bounded retry budget.",
				changedFiles,
				checks: checkPass.results,
				checker: checkPass.report,
				quality: summarizeWorkflowQualityStats(workflowQualityStats),
				workerResults,
				acceptedResidualSoftFindings,
				blockingHardFindings,
			}),
			workerResults,
		};
	}

	options.onStageChange?.("validator");
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-started",
		stage: "validator",
		lines: [
			"Comparing the resumed fast-mode implementation against PLAN.md.",
			`Changed files: ${summarizePaths(changedFiles)}`,
			`Checker findings: ${checkPass.report.findings.length}`,
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			checkerModels: checkPass.modelRuns.map((run) => run.model),
			note: "Resumed fast-mode validator started",
		},
	});
	const validation = await runValidator({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		validatorPrompt: options.validatorPrompt,
		decomposition: options.decomposition,
		workerResults,
		changedFiles,
		checkerReport: checkPass.report,
		checkResults: checkPass.results,
		model: options.primaryModel,
		thinkingLevel: options.thinkingLevel,
	});
	const discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-completed",
		stage: "validator",
		lines: [
			`Validator recommendation: ${validation.recommendation}`,
			validation.summary || `${validation.discrepancies.length} discrepancy(s) reported.`,
			...(discrepancySummaryItems.length > 0 ? [`Discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			discrepancyCount: validation.discrepancies.length,
			discrepancySummary: discrepancySummaryItems,
			recommendation: validation.recommendation,
			note: "Resumed fast-mode validator completed",
		},
	});
	if (validation.discrepancies.length > 0) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "validator",
			lines: [
				`Validator reported ${validation.discrepancies.length} remaining plan discrepancy(s).`,
				"Fast mode stays bounded: remaining discrepancies are reported in the final summary instead of triggering more remediation loops.",
				...(discrepancySummaryItems.length > 0 ? [`Top discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
			],
			context: {
				discrepancyCount: validation.discrepancies.length,
				discrepancySummary: discrepancySummaryItems,
				recommendation: validation.recommendation,
				note: "Resumed fast-mode validator discrepancies recorded for advisory follow-up",
			},
		});
	}

	const summary = buildSummary(
		changedFiles,
		checkPass.results,
		validation,
		checkPass.report,
		summarizeWorkflowQualityStats(workflowQualityStats),
		{
			acceptedResidualSoftFindings,
			blockingHardFindings,
		},
	);
	return {
		decision: "done",
		summary,
	};
}

async function runResumedStrictImplementationWorkflow(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	cleanupPrompt: string;
	designReviewPrompt: string;
	checkerPrompt: string;
	validatorPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
	promptForHardGateChoice?: (decision: FinalCheckerHardGateDecision) => Promise<FinalCheckerHardGateChoice>;
	integrateRunWorkspace: () => Promise<void>;
}): Promise<{
	decision: Extract<WorkflowDecision, "done" | "stopped">;
	summary: string;
	workerResults?: WorkerPhaseResult[];
}> {
	let changedFiles = await detectChangedFiles(options.cwd, options.exec);
	const workerResults = options.workerResults;
	const workflowQualityStats = createWorkflowQualityStats();

	emitWorkflowUpdate(options.onUpdate, {
		type: "detail-lines",
		stage: "starting",
		lines: [
			"Resuming the strict sub-agent workflow from the preserved isolated workspace.",
			`Changed files already present: ${summarizePaths(changedFiles)}`,
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			note: "Strict-mode resume started",
		},
	});

	const verificationPass = await runMergedResultVerification({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		cleanupPrompt: options.cleanupPrompt,
		designReviewPrompt: options.designReviewPrompt,
		checkerPrompt: options.checkerPrompt,
		decomposition: options.decomposition,
		workerResults,
		changedFiles,
		exec: options.exec,
		primaryModel: options.primaryModel,
		checkerModels: options.checkerModels,
		thinkingLevel: options.thinkingLevel,
		onUpdate: options.onUpdate,
		onStageChange: options.onStageChange,
		verificationReason: "resumed merged implementation result",
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		promptForHardGateChoice: options.promptForHardGateChoice,
	});
	mergeWorkflowQualityStats(workflowQualityStats, verificationPass.stats);
	changedFiles = verificationPass.changedFiles;
	const acceptedResidualSoftFindings = verificationPass.acceptedResidualSoftFindings;
	const blockingHardFindings = verificationPass.blockingHardFindings;
	const checkPass = verificationPass.checkerRun;

	if (verificationPass.outcome === "stopped-hard") {
		return {
			decision: "stopped",
			summary: buildStoppedSummary({
				reason:
					verificationPass.stopReason ??
					"Final checker stopped with hard-blocking findings still remaining after the bounded retry budget.",
				changedFiles,
				checks: checkPass.results,
				checker: checkPass.report,
				quality: summarizeWorkflowQualityStats(workflowQualityStats),
				workerResults,
				acceptedResidualSoftFindings,
				blockingHardFindings,
			}),
			workerResults,
		};
	}

	options.onStageChange?.("validator");
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-started",
		stage: "validator",
		lines: [
			"Comparing the resumed implementation against PLAN.md.",
			`Changed files: ${summarizePaths(changedFiles)}`,
			`Checker findings: ${checkPass.report.findings.length}`,
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			checkerModels: checkPass.modelRuns.map((run) => run.model),
			note: "Resumed validator started",
		},
	});
	const validation = await runValidator({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		validatorPrompt: options.validatorPrompt,
		decomposition: options.decomposition,
		workerResults,
		changedFiles,
		checkerReport: checkPass.report,
		checkResults: checkPass.results,
		model: options.primaryModel,
		thinkingLevel: options.thinkingLevel,
	});
	let discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
	emitWorkflowUpdate(options.onUpdate, {
		type: "validator-completed",
		stage: "validator",
		lines: [
			`Validator recommendation: ${validation.recommendation}`,
			validation.summary || `${validation.discrepancies.length} discrepancy(s) reported.`,
			...(discrepancySummaryItems.length > 0 ? [`Discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
		],
		context: {
			changedFiles,
			changedFilesSummary: summarizePaths(changedFiles),
			discrepancyCount: validation.discrepancies.length,
			discrepancySummary: discrepancySummaryItems,
			recommendation: validation.recommendation,
			note: "Resumed validator completed",
		},
	});
	if (validation.discrepancies.length > 0) {
		discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "validator",
			lines: [
				`Validator reported ${validation.discrepancies.length} remaining plan discrepancy(s).`,
				"Keeping the sub-agent workflow bounded: remaining discrepancies are reported in the final summary instead of triggering another implementation loop.",
				...(discrepancySummaryItems.length > 0 ? [`Top discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
			],
			context: {
				discrepancyCount: validation.discrepancies.length,
				discrepancySummary: discrepancySummaryItems,
				recommendation: validation.recommendation,
				note: "Resumed validator discrepancies recorded for advisory follow-up",
			},
		});
	}

	await options.integrateRunWorkspace();
	const summary = buildSummary(
		changedFiles,
		checkPass.results,
		validation,
		checkPass.report,
		summarizeWorkflowQualityStats(workflowQualityStats),
		{
			acceptedResidualSoftFindings,
			blockingHardFindings,
		},
	);
	return {
		decision: "done",
		summary,
	};
}

async function runCheckerSuite(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	checkerPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	checkerModels: string[];
	exec: ExecLike;
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
}): Promise<CheckerSuiteResult> {
	const context = await prepareReviewContextFiles({
		cwd: options.cwd,
		tempDir: options.tempDir,
		prefix: "checker",
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		decomposition: options.decomposition,
		workerResults: options.workerResults,
		changedFiles: options.changedFiles,
	});

	const modelRuns: CheckerModelRun[] = [];
	const results: CheckRunSummary[] = [];
	const reviewModels = options.checkerModels.length > 0 ? options.checkerModels : [undefined];
	for (const model of reviewModels) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "checker",
			lines: [
				`Running checker model ${model ?? "default"}`,
				`Changed files: ${summarizePaths(options.changedFiles)}`,
				`Relevant AGENTS.md files: ${context.guidance.documents.length}`,
			],
			context: {
				checkerModel: model ?? "default",
				checkerModels: reviewModels.filter((value): value is string => Boolean(value)),
				changedFiles: options.changedFiles,
				changedFilesSummary: summarizePaths(options.changedFiles),
				note: `Checker review ${model ?? "default"}`,
			},
		});
		try {
			const report = await runStructuredStage({
				name: `checker-${model ?? "default"}`,
				systemPrompt: options.checkerPrompt,
				prompt: "Review the implementation, the changed files, the worker summaries, and the relevant AGENTS.md guidance. Return JSON only.",
				files: context.files,
				tools: READ_ONLY_SUBAGENT_TOOLS,
				cwd: options.cwd,
				model,
				thinkingLevel: options.thinkingLevel,
				tempDir: options.tempDir,
				parse: parseCheckerReport,
			});
			const summary: CheckRunSummary = {
				command: "model-review",
				source: model ?? "default",
				status: report.findings.length > 0 ? "failed" : "passed",
				summary: report.overallAssessment || `${report.findings.length} finding(s)`,
			};
			results.push(summary);
			modelRuns.push({
				model: model ?? "default",
				report,
				summary,
			});
		} catch (error) {
			results.push({
				command: "model-review",
				source: model ?? "default",
				status: "error",
				summary: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (modelRuns.length === 0) {
		throw new Error(results[0]?.summary || "All checker models failed");
	}

	const agentsCheckCommands = collectAgentsCheckCommands(context.guidance.documents);
	const agentsCheckExecutionPolicy =
		agentsCheckCommands.length > 0
			? await (options.resolveAgentsCheckExecutionPolicy?.(agentsCheckCommands) ?? Promise.resolve({ allowed: true }))
			: { allowed: true };
	if (agentsCheckCommands.length > 0) {
		emitWorkflowUpdate(options.onUpdate, {
			type: "detail-lines",
			stage: "checker",
			lines: [
				agentsCheckExecutionPolicy.allowed
					? `Running ${agentsCheckCommands.length} AGENTS.md-required check command(s).`
					: `Blocking ${agentsCheckCommands.length} AGENTS.md-required check command(s).`,
				...summarizeAgentsCheckCommands(agentsCheckCommands, 3),
				...(agentsCheckExecutionPolicy.allowed || !agentsCheckExecutionPolicy.reason
					? []
					: [agentsCheckExecutionPolicy.reason]),
			],
			context: {
				changedFiles: options.changedFiles,
				changedFilesSummary: summarizePaths(options.changedFiles),
				note: agentsCheckExecutionPolicy.allowed ? "Running AGENTS.md-required checks" : "AGENTS.md checks blocked",
			},
		});
	}
	const agentsCheckRuns = await runAgentsCheckCommands({
		cwd: options.cwd,
		exec: options.exec,
		commands: agentsCheckCommands,
		policy: agentsCheckExecutionPolicy,
	});
	const agentsCheckResults: CheckRunSummary[] = agentsCheckRuns.map((run) => ({
		command: run.command,
		source: run.source,
		status: run.status,
		summary: run.summary,
	}));
	results.push(...agentsCheckResults);
	const report = appendAgentsChecksToCheckerReport(combineCheckerReports(modelRuns), agentsCheckRuns);
	return { report, guidance: context.guidance, results, agentsCheckResults, modelRuns };
}

async function runValidator(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	validatorPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	checkerReport: CheckerReport;
	checkResults: CheckRunSummary[];
	model?: string;
	thinkingLevel?: string;
}): Promise<ValidationReport> {
	const context = await prepareReviewContextFiles({
		cwd: options.cwd,
		tempDir: options.tempDir,
		prefix: "validator",
		planPath: options.planPath,
		agentFiles: options.agentFiles,
		decomposition: options.decomposition,
		workerResults: options.workerResults,
		changedFiles: options.changedFiles,
	});
	const checkerPath = await writeTempContextFile(options.tempDir, "validator-checker.md", renderCheckerFindingsSummary(options.checkerReport));
	const checkResultsPath = await writeTempContextFile(options.tempDir, "validator-check-results.md", renderCheckResultsSummary(options.checkResults));

	return await runStructuredStage({
		name: "validator",
		systemPrompt: options.validatorPrompt,
		prompt:
			"Compare the approved plan against the current implementation and return JSON only. Treat any failed or blocked AGENTS.md-required checks in the attached checker findings and check-results context as blocking implementation gaps.",
		files: [...context.files, checkerPath, checkResultsPath],
		tools: READ_ONLY_SUBAGENT_TOOLS,
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tempDir: options.tempDir,
		parse: parseValidationReport,
	});
}

interface TargetedFollowThroughResult {
	changedFiles: string[];
	stats: WorkflowQualityStats;
	deferredSoftFindings: QualityGateFindingSummary[];
}

type CheckerLoopOutcome = "pass" | "accepted-soft" | "stopped-hard";

interface CheckerLoopResult {
	outcome: CheckerLoopOutcome;
	stopReason?: string;
	changedFiles: string[];
	checkerRun: CheckerSuiteResult;
	stats: WorkflowQualityStats;
	acceptedResidualSoftFindings: QualityGateFindingSummary[];
	blockingHardFindings: QualityGateFindingSummary[];
}

interface MergedResultVerificationResult {
	outcome: CheckerLoopOutcome;
	stopReason?: string;
	changedFiles: string[];
	checkerRun: CheckerSuiteResult;
	stats: WorkflowQualityStats;
	acceptedResidualSoftFindings: QualityGateFindingSummary[];
	blockingHardFindings: QualityGateFindingSummary[];
}

function renderTargetedFollowThroughRemediationContext(options: {
	round: number;
	phase: DecompositionPhase;
	changedFiles: string[];
	cleanupRun: SpecialistReviewRun;
	designRun: SpecialistReviewRun | null;
}): string {
	return trimBlock(
		[
			"## Targeted phase follow-through remediation",
			"",
			`- phase: ${options.phase.id} — ${options.phase.title}`,
			`- round: ${options.round}/${TARGETED_FOLLOW_THROUGH_MAX_ROUNDS}`,
			`- changed files in scope: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			"",
			renderFindingReportSummary("Cleanup findings", options.cleanupRun.report),
			"",
			options.designRun
				? renderFindingReportSummary("Design review findings", options.designRun.report)
				: trimBlock(["## Design review", "", "Skipped for this targeted follow-through round."].join("\n")),
		].join("\n"),
	);
}

async function runPhaseFollowThroughLoop(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	cleanupPrompt: string;
	designReviewPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	phase: DecompositionPhase;
	changedFiles: string[];
	exec: ExecLike;
	primaryModel?: string;
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	discrepancyContextText?: string;
}): Promise<TargetedFollowThroughResult> {
	let currentChangedFiles = uniquePaths(options.changedFiles);
	const stats = createWorkflowQualityStats();
	let deferredSoftFindings: QualityGateFindingSummary[] = [];

	for (let round = 1; round <= TARGETED_FOLLOW_THROUGH_MAX_ROUNDS; round++) {
		const scopedFiles = buildTargetedReviewFiles({
			changedFiles: currentChangedFiles,
			touchedPaths: options.phase.touchedPaths,
		});
		const scopeContextPath = await writeTempContextFile(
			options.tempDir,
			`${options.phase.id.replace(/\W+/g, "-")}-follow-through-scope-${round}.md`,
			renderTargetedFollowThroughScopeContext({
				phase: options.phase,
				round,
				changedFiles: scopedFiles,
				touchedPaths: options.phase.touchedPaths,
				discrepancyContextText: options.discrepancyContextText,
			}),
		);
		const reviewAgentFiles = [...options.agentFiles, scopeContextPath];
		const designRequired = shouldRunDesignReview({
			phases: [options.phase],
			changedFiles: scopedFiles,
			discrepancyText: options.discrepancyContextText,
		});
		const roundLabel = `Follow-through round ${round}/${TARGETED_FOLLOW_THROUGH_MAX_ROUNDS}`;

		options.onStageChange?.("cleanup");
		emitWorkflowUpdate(options.onUpdate, {
			type: "cleanup-started",
			stage: "cleanup",
			lines: [
				`${roundLabel}: targeted cleanup for ${options.phase.title}`,
				`Scope: ${summarizePaths(scopedFiles)}`,
			],
			context: {
				phaseId: options.phase.id,
				phaseTitle: options.phase.title,
				changedFiles: scopedFiles,
				changedFilesSummary: summarizePaths(scopedFiles),
				qualityRound: round,
				qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
				designReviewNeeded: designRequired,
				note: `${roundLabel} targeted cleanup started`,
			},
		});
		const cleanupRun = await runSpecialistReview({
			name: `${options.phase.id}-follow-through-cleanup-${round}`,
			prefix: `${options.phase.id}-follow-through-cleanup-${round}`,
			reviewCommand: "cleanup-audit",
			systemPrompt: options.cleanupPrompt,
			prompt:
				"Run a targeted cleanup follow-through review for the attached phase scope. Stay within the provided scope context, report only do-now cleanup issues, and return JSON only.",
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: reviewAgentFiles,
			decomposition: options.decomposition,
			workerResults: options.workerResults,
			changedFiles: scopedFiles,
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		stats.cleanupRuns += 1;
		updateLegacyCleanupEvidence(stats, cleanupRun.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "cleanup-completed",
			stage: "cleanup",
			lines: [
				`${roundLabel}: targeted cleanup found ${cleanupRun.report.findings.length} finding(s).`,
				cleanupRun.report.findings.length > 0
					? `Top findings: ${summarizeFindingsList(cleanupRun.report.findings).join(" • ")}`
					: `Scope: ${summarizePaths(scopedFiles)}`,
			],
			context: {
				phaseId: options.phase.id,
				phaseTitle: options.phase.title,
				changedFiles: scopedFiles,
				changedFilesSummary: summarizePaths(scopedFiles),
				qualityRound: round,
				qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
				note: `${roundLabel} targeted cleanup completed`,
			},
		});

		let designRun: SpecialistReviewRun | null = null;
		if (designRequired) {
			options.onStageChange?.("design");
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-started",
				stage: "design",
				lines: [
					`${roundLabel}: targeted design review for ${options.phase.title}`,
					`Scope: ${summarizePaths(scopedFiles)}`,
				],
				context: {
					phaseId: options.phase.id,
					phaseTitle: options.phase.title,
					changedFiles: scopedFiles,
					changedFilesSummary: summarizePaths(scopedFiles),
					qualityRound: round,
					qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
					designReviewNeeded: true,
					note: `${roundLabel} targeted design review started`,
				},
			});
			designRun = await runSpecialistReview({
				name: `${options.phase.id}-follow-through-design-${round}`,
				prefix: `${options.phase.id}-follow-through-design-${round}`,
				reviewCommand: "design-review",
				systemPrompt: options.designReviewPrompt,
				prompt:
					"Run a targeted design follow-through review for the attached phase scope. Stay within the provided scope context, report only concrete now-fix issues, and return JSON only.",
				cwd: options.cwd,
				tempDir: options.tempDir,
				planPath: options.planPath,
				agentFiles: reviewAgentFiles,
				decomposition: options.decomposition,
				workerResults: options.workerResults,
				changedFiles: scopedFiles,
				model: options.primaryModel,
				thinkingLevel: options.thinkingLevel,
			});
			stats.designReviewRuns += 1;
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-completed",
				stage: "design",
				lines: [
					`${roundLabel}: targeted design review found ${designRun.report.findings.length} finding(s).`,
					designRun.report.findings.length > 0
						? `Top findings: ${summarizeFindingsList(designRun.report.findings).join(" • ")}`
						: `Scope: ${summarizePaths(scopedFiles)}`,
				],
				context: {
					phaseId: options.phase.id,
					phaseTitle: options.phase.title,
					changedFiles: scopedFiles,
					changedFilesSummary: summarizePaths(scopedFiles),
					qualityRound: round,
					qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
					note: `${roundLabel} targeted design review completed`,
				},
			});
		} else {
			stats.designReviewSkips += 1;
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-skipped",
				stage: "design",
				lines: [
					`${roundLabel}: skipping targeted design review for ${options.phase.title}`,
					"No design-sensitive signals were detected for this phase scope.",
				],
				context: {
					phaseId: options.phase.id,
					phaseTitle: options.phase.title,
					changedFiles: scopedFiles,
					changedFilesSummary: summarizePaths(scopedFiles),
					qualityRound: round,
					qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
					designReviewNeeded: false,
					note: `${roundLabel} targeted design review skipped`,
				},
			});
		}

		const cleanupGate = partitionQualityGateFindings("cleanup", cleanupRun.report.findings);
		const designGate = partitionQualityGateFindings("design", designRun?.report.findings ?? []);
		const hardFindings = [...cleanupGate.hard, ...designGate.hard];
		const softFindings = [...cleanupGate.soft, ...designGate.soft];
		if (hardFindings.length === 0 && softFindings.length === 0) {
			return { changedFiles: currentChangedFiles, stats, deferredSoftFindings: [] };
		}
		if (hardFindings.length === 0) {
			deferredSoftFindings = softFindings;
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "design",
				lines: [
					`Deferring ${softFindings.length} non-critical targeted follow-through note(s) to the final holistic pass.`,
				],
				context: {
					phaseId: options.phase.id,
					phaseTitle: options.phase.title,
					changedFiles: scopedFiles,
					changedFilesSummary: summarizePaths(scopedFiles),
					note: "Targeted follow-through stopped after soft findings only",
				},
			});
			return { changedFiles: currentChangedFiles, stats, deferredSoftFindings };
		}
		if (round >= TARGETED_FOLLOW_THROUGH_MAX_ROUNDS) {
			throw new Error(
				`Targeted follow-through for ${options.phase.title} stopped with hard findings still remaining: ${renderQualityGateCountsSummary(hardFindings)}.`,
			);
		}

		for (const stage of [
			...(cleanupRun.report.findings.length > 0 ? (["cleanup"] as const) : []),
			...(designRun && designRun.report.findings.length > 0 ? (["design"] as const) : []),
		]) {
			emitLoopTraversal(
				options.onUpdate,
				QUALITY_STAGE_FIX_EDGE[stage],
				"fix",
				[
					`${roundLabel}: ${stage} requested targeted remediation for ${options.phase.title}.`,
					`Scope: ${summarizePaths(scopedFiles)}`,
				],
				{
					phaseId: options.phase.id,
					phaseTitle: options.phase.title,
					changedFiles: scopedFiles,
					changedFilesSummary: summarizePaths(scopedFiles),
					qualityRound: round,
					qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
					note: `${roundLabel} ${stage} requested targeted remediation`,
				},
			);
		}
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: [options.phase],
			changedFiles: scopedFiles,
			findings: [...cleanupRun.report.findings, ...(designRun?.report.findings ?? [])],
			discrepancyText: options.discrepancyContextText,
		});
		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				`${roundLabel}: applying targeted follow-through fixes for ${options.phase.title}.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				phaseId: options.phase.id,
				phaseTitle: options.phase.title,
				changedFiles: scopedFiles,
				changedFilesSummary: summarizePaths(scopedFiles),
				workerKind: remediationPromptSelection.kind,
				qualityRound: round,
				qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: reviewAgentFiles,
			touchedPaths: scopedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: `${options.phase.id}-follow-through-fix-${round}`,
			contextMarkdown: renderTargetedFollowThroughRemediationContext({
				round,
				phase: options.phase,
				changedFiles: scopedFiles,
				cleanupRun,
				designRun,
			}),
			prompt:
				"Apply the attached targeted cleanup/design findings now. Stay inside the provided phase scope, fix only concrete issues, and then summarize what changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		options.workerResults.push({
			phase: {
				id: `${options.phase.id}-follow-through-fix-${round}`,
				title: `${options.phase.title} targeted follow-through remediation ${round}`,
				goal: `Resolve targeted follow-through findings for ${options.phase.title}`,
				instructions: [`Resolve targeted cleanup/design follow-through findings for ${options.phase.id}.`],
				dependsOn: [options.phase.id],
				touchedPaths: scopedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		stats.remediationPasses += 1;
		if (cleanupRun.report.findings.length > 0) recordQualityFindings(stats, "cleanup", cleanupRun.report.findings);
		if (designRun?.report.findings.length) recordQualityFindings(stats, "design", designRun.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: [
				`${roundLabel}: completed targeted follow-through remediation for ${options.phase.title}.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				phaseId: options.phase.id,
				phaseTitle: options.phase.title,
				changedFiles: scopedFiles,
				changedFilesSummary: summarizePaths(scopedFiles),
				workerKind: remediationPromptSelection.kind,
				qualityRound: round,
				qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
				note: remediationPromptSelection.reason,
			},
		});
		currentChangedFiles = await detectChangedFiles(options.cwd, options.exec);
		emitLoopTraversal(
			options.onUpdate,
			"fix->cleanup",
			"cleanup",
			[
				`${roundLabel}: re-running targeted follow-through for ${options.phase.title}.`,
				`Scope: ${summarizePaths(buildTargetedReviewFiles({ changedFiles: currentChangedFiles, touchedPaths: options.phase.touchedPaths }))}`,
			],
			{
				phaseId: options.phase.id,
				phaseTitle: options.phase.title,
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: TARGETED_FOLLOW_THROUGH_MAX_ROUNDS,
				note: `${roundLabel} restarting targeted follow-through`,
			},
		);
	}

	return { changedFiles: currentChangedFiles, stats, deferredSoftFindings };
}

function renderMergedResultRemediationContext(options: {
	reason: string;
	changedFiles: string[];
	findings: QualityGateFindingSummary[];
}): string {
	return trimBlock(
		[
			"## Final holistic remediation",
			"",
			`verification reason: ${options.reason}`,
			`changed files: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			"",
			renderQualityGateFindingsSection("Blocking final holistic findings", options.findings, "No blocking findings."),
		].join("\n"),
	);
}

async function runCheckerLoop(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	checkerPrompt: string;
	workerPrompt: string;
	designWorkerPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
	holisticSoftFindings?: QualityGateFindingSummary[];
	promptForHardGateChoice?: (decision: FinalCheckerHardGateDecision) => Promise<FinalCheckerHardGateChoice>;
}): Promise<CheckerLoopResult> {
	let currentChangedFiles = uniquePaths(options.changedFiles);
	const stats = createWorkflowQualityStats();
	let checkerRun!: CheckerSuiteResult;
	let manualContinueBudget = 0;

	for (let round = 1; round <= FINAL_CHECKER_MAX_PASSES + manualContinueBudget; round++) {
		let roundBudgetTotal = FINAL_CHECKER_MAX_PASSES + manualContinueBudget;
		const scopeContextPath = await writeTempContextFile(
			options.tempDir,
			`final-checker-scope-${round}.md`,
			renderFinalCheckerScopeContext({
				round,
				totalPasses: roundBudgetTotal,
				changedFiles: currentChangedFiles,
				softFindings: options.holisticSoftFindings ?? [],
			}),
		);
		const checkerAgentFiles = [...options.agentFiles, scopeContextPath];
		options.onStageChange?.("checker");
		emitWorkflowUpdate(options.onUpdate, {
			type: "checker-started",
			stage: "checker",
			lines: [
				`Final checker pass ${round}/${roundBudgetTotal}`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `Final checker pass ${round} started`,
			},
		});
		checkerRun = await runCheckerSuite({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: checkerAgentFiles,
			checkerPrompt: options.checkerPrompt,
			decomposition: options.decomposition,
			workerResults: options.workerResults,
			changedFiles: currentChangedFiles,
			checkerModels: options.checkerModels,
			exec: options.exec,
			thinkingLevel: options.thinkingLevel,
			onUpdate: options.onUpdate,
			resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		});
		stats.checkerRuns += 1;
		stats.agentsCheckResults.push(...checkerRun.agentsCheckResults);
		emitWorkflowUpdate(options.onUpdate, {
			type: "checker-completed",
			stage: "checker",
			lines: [
				`Final checker pass ${round}/${roundBudgetTotal} finished with ${checkerRun.report.findings.length} finding(s).`,
				checkerRun.report.findings.length > 0
					? `Top findings: ${summarizeCheckerFindings(checkerRun.report).join(" • ")}`
					: `Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `Final checker pass ${round} completed`,
			},
		});
		const checkerGate = partitionQualityGateFindings("checker", checkerRun.report.findings);
		if (checkerGate.hard.length === 0 && checkerGate.soft.length === 0) {
			return {
				outcome: "pass",
				changedFiles: currentChangedFiles,
				checkerRun,
				stats,
				acceptedResidualSoftFindings: [],
				blockingHardFindings: [],
			};
		}
		if (round >= roundBudgetTotal && checkerGate.hard.length > 0) {
			const stopMessage = `Final checker stopped after ${roundBudgetTotal} pass(es). Hard-blocking findings remain: ${renderQualityGateCountsSummary(checkerGate.hard)}.`;
			if (options.promptForHardGateChoice) {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "checker",
					lines: [
						stopMessage,
						`Changed files: ${summarizePaths(currentChangedFiles)}`,
						"Awaiting your choice: continue remediating inside the isolated workspace, or stop and summarize the current progress.",
					],
					context: {
						changedFiles: currentChangedFiles,
						changedFilesSummary: summarizePaths(currentChangedFiles),
						qualityRound: round,
						qualityRounds: roundBudgetTotal,
						note: "Awaiting final-checker hard-gate decision",
					},
				});
				const choice = await options.promptForHardGateChoice({
					round,
					roundBudget: {
						base: FINAL_CHECKER_MAX_PASSES,
						extra: manualContinueBudget,
						total: roundBudgetTotal,
					},
					message: stopMessage,
					changedFiles: currentChangedFiles,
					hardGateFindings: checkerGate.hard,
					softGateFindings: checkerGate.soft,
					checkerRun,
				});
				if (choice === "Stop and summarize current progress") {
					emitWorkflowUpdate(options.onUpdate, {
						type: "detail-lines",
						stage: "checker",
						lines: [
							stopMessage,
							"Stopping gracefully and returning a summary of what was completed and what remains.",
							"The isolated workspace result will not be applied to the original checkout.",
						],
						context: {
							changedFiles: currentChangedFiles,
							changedFilesSummary: summarizePaths(currentChangedFiles),
							qualityRound: round,
							qualityRounds: roundBudgetTotal,
							note: "Final checker stopped gracefully after hard-gate prompt",
						},
					});
					return {
						outcome: "stopped-hard",
						stopReason: stopMessage,
						changedFiles: currentChangedFiles,
						checkerRun,
						stats,
						acceptedResidualSoftFindings: checkerGate.soft,
						blockingHardFindings: checkerGate.hard,
					};
				}
				manualContinueBudget += 1;
				roundBudgetTotal = FINAL_CHECKER_MAX_PASSES + manualContinueBudget;
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "checker",
					lines: [
						`Manual continuation granted. Final checker budget extended to ${roundBudgetTotal} pass(es).`,
						"Continuing remediation inside the existing isolated workspace.",
					],
					context: {
						changedFiles: currentChangedFiles,
						changedFilesSummary: summarizePaths(currentChangedFiles),
						qualityRound: round,
						qualityRounds: roundBudgetTotal,
						note: "Final checker continuation granted by user",
					},
				});
			} else {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "checker",
					lines: [
						stopMessage,
						"Stopping gracefully and returning a summary of what was completed and what remains.",
						"The isolated workspace result will not be applied to the original checkout.",
					],
					context: {
						changedFiles: currentChangedFiles,
						changedFilesSummary: summarizePaths(currentChangedFiles),
						qualityRound: round,
						qualityRounds: roundBudgetTotal,
						note: "Final checker stopped gracefully without interactive override",
					},
				});
				return {
					outcome: "stopped-hard",
					stopReason: stopMessage,
					changedFiles: currentChangedFiles,
					checkerRun,
					stats,
					acceptedResidualSoftFindings: checkerGate.soft,
					blockingHardFindings: checkerGate.hard,
				};
			}
		}
		if (round >= roundBudgetTotal) {
			return {
				outcome: "accepted-soft",
				changedFiles: currentChangedFiles,
				checkerRun,
				stats,
				acceptedResidualSoftFindings: checkerGate.soft,
				blockingHardFindings: [],
			};
		}
		emitLoopTraversal(
			options.onUpdate,
			"checker->fix",
			"fix",
			[
				`Final checker pass ${round}/${roundBudgetTotal} requested remediation.`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			{
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `Final checker pass ${round} requested remediation`,
			},
		);
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: options.workerResults.map((result) => result.phase),
			changedFiles: currentChangedFiles,
			findings: checkerRun.report.findings,
		});
		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				`Applying final checker remediation after pass ${round}/${roundBudgetTotal}.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				workerKind: remediationPromptSelection.kind,
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: checkerAgentFiles,
			touchedPaths: currentChangedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: `final-checker-fix-${round}`,
			contextMarkdown: renderFindingReportSummary("Checker findings", checkerRun.report),
			prompt:
				"Apply the attached checker findings now. Focus on logic, regressions, side effects, correctness, and guidance issues, then summarize what changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		options.workerResults.push({
			phase: {
				id: `final-checker-fix-${round}`,
				title: `Final checker remediation ${round}`,
				goal: "Resolve final checker findings",
				instructions: [`Resolve final checker findings from pass ${round}.`],
				dependsOn: [],
				touchedPaths: currentChangedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		stats.remediationPasses += 1;
		recordQualityFindings(stats, "checker", checkerRun.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: [
				`Completed final checker remediation after pass ${round}/${roundBudgetTotal}.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				workerKind: remediationPromptSelection.kind,
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: remediationPromptSelection.reason,
			},
		});
		currentChangedFiles = await detectChangedFiles(options.cwd, options.exec);
		emitLoopTraversal(
			options.onUpdate,
			"fix->checker",
			"checker",
			[
				`Re-running the final checker after remediation from pass ${round}/${roundBudgetTotal}.`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			{
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `Re-running final checker after remediation from pass ${round}`,
			},
		);
	}

	throw new Error(`Final checker exhausted ${FINAL_CHECKER_MAX_PASSES + manualContinueBudget} pass(es).`);
}

async function runMergedResultVerification(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	cleanupPrompt: string;
	designReviewPrompt: string;
	checkerPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	verificationReason: string;
	designContextText?: string;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
	promptForHardGateChoice?: (decision: FinalCheckerHardGateDecision) => Promise<FinalCheckerHardGateChoice>;
}): Promise<MergedResultVerificationResult> {
	let currentChangedFiles = uniquePaths(options.changedFiles);
	const stats = createWorkflowQualityStats();
	stats.mergedResultVerificationRuns += 1;
	if (options.verificationReason.trim()) stats.mergedResultVerificationReasons.add(options.verificationReason.trim());
	const holisticScopePath = await writeTempContextFile(
		options.tempDir,
		`merged-result-scope-${stats.mergedResultVerificationRuns}.md`,
		renderFinalHolisticScopeContext({
			changedFiles: currentChangedFiles,
			workerResults: options.workerResults,
			discrepancyContextText: options.designContextText,
		}),
	);
	const reviewAgentFiles = [...options.agentFiles, holisticScopePath];

	options.onStageChange?.("cleanup");
	emitWorkflowUpdate(options.onUpdate, {
		type: "cleanup-started",
		stage: "cleanup",
		lines: [
			`Final holistic cleanup pass (${options.verificationReason}).`,
			`Changed files: ${summarizePaths(currentChangedFiles)}`,
		],
		context: {
			changedFiles: currentChangedFiles,
			changedFilesSummary: summarizePaths(currentChangedFiles),
			note: "Final holistic cleanup started",
		},
	});
	const cleanupRun = await runSpecialistReview({
		name: `merged-result-cleanup-${stats.mergedResultVerificationRuns}`,
		prefix: `merged-result-cleanup-${stats.mergedResultVerificationRuns}`,
		reviewCommand: "cleanup-audit",
		systemPrompt: options.cleanupPrompt,
		prompt:
			"Run one final holistic cleanup review for the merged implementation result. Only report glaring feature-level cleanup issues that should block completion now. Return JSON only.",
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: reviewAgentFiles,
		decomposition: options.decomposition,
		workerResults: options.workerResults,
		changedFiles: currentChangedFiles,
		model: options.primaryModel,
		thinkingLevel: options.thinkingLevel,
	});
	stats.cleanupRuns += 1;
	updateLegacyCleanupEvidence(stats, cleanupRun.report.findings);
	emitWorkflowUpdate(options.onUpdate, {
		type: "cleanup-completed",
		stage: "cleanup",
		lines: [
			`Final holistic cleanup found ${cleanupRun.report.findings.length} finding(s).`,
			cleanupRun.report.findings.length > 0
				? `Top findings: ${summarizeFindingsList(cleanupRun.report.findings).join(" • ")}`
				: `Changed files: ${summarizePaths(currentChangedFiles)}`,
		],
		context: {
			changedFiles: currentChangedFiles,
			changedFilesSummary: summarizePaths(currentChangedFiles),
			note: "Final holistic cleanup completed",
		},
	});

	let designRun: SpecialistReviewRun | null = null;
	const designRequired = shouldRunDesignReview({
		phases: options.workerResults.map((result) => result.phase),
		changedFiles: currentChangedFiles,
		discrepancyText: options.designContextText,
	});
	if (designRequired) {
		options.onStageChange?.("design");
		emitWorkflowUpdate(options.onUpdate, {
			type: "design-started",
			stage: "design",
			lines: [
				"Final holistic design review.",
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				designReviewNeeded: true,
				note: "Final holistic design review started",
			},
		});
		designRun = await runSpecialistReview({
			name: `merged-result-design-${stats.mergedResultVerificationRuns}`,
			prefix: `merged-result-design-${stats.mergedResultVerificationRuns}`,
			reviewCommand: "design-review",
			systemPrompt: options.designReviewPrompt,
			prompt:
				"Run one final holistic design review for the merged implementation result. Only report glaring feature-level design issues that should block completion now. Return JSON only.",
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: reviewAgentFiles,
			decomposition: options.decomposition,
			workerResults: options.workerResults,
			changedFiles: currentChangedFiles,
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		stats.designReviewRuns += 1;
		emitWorkflowUpdate(options.onUpdate, {
			type: "design-completed",
			stage: "design",
			lines: [
				`Final holistic design review found ${designRun.report.findings.length} finding(s).`,
				designRun.report.findings.length > 0
					? `Top findings: ${summarizeFindingsList(designRun.report.findings).join(" • ")}`
					: `Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				note: "Final holistic design review completed",
			},
		});
	} else {
		stats.designReviewSkips += 1;
		emitWorkflowUpdate(options.onUpdate, {
			type: "design-skipped",
			stage: "design",
			lines: [
				"Skipping the final holistic design review.",
				"No design-sensitive signals were detected in the merged result.",
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				designReviewNeeded: false,
				note: "Final holistic design review skipped",
			},
		});
	}

	const cleanupGate = partitionQualityGateFindings("cleanup", cleanupRun.report.findings);
	const designGate = partitionQualityGateFindings("design", designRun?.report.findings ?? []);
	const holisticSoftFindings = [...cleanupGate.soft, ...designGate.soft];
	const holisticHardFindings = [...cleanupGate.hard, ...designGate.hard];
	if (holisticHardFindings.length > 0) {
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: options.workerResults.map((result) => result.phase),
			changedFiles: currentChangedFiles,
			findings: [
				...cleanupRun.report.findings.filter((finding) => classifyQualityGateFinding("cleanup", finding) === "hard"),
				...(designRun?.report.findings ?? []).filter((finding) => classifyQualityGateFinding("design", finding) === "hard"),
			],
			discrepancyText: options.designContextText,
		});
		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				`Applying ${holisticHardFindings.length} blocking final holistic finding(s) before the checker loop.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: reviewAgentFiles,
			touchedPaths: currentChangedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: `merged-result-fix-${stats.mergedResultVerificationRuns}`,
			contextMarkdown: renderMergedResultRemediationContext({
				reason: options.verificationReason,
				changedFiles: currentChangedFiles,
				findings: holisticHardFindings,
			}),
			prompt:
				"Apply the attached blocking final cleanup/design findings once before the checker loop. Keep the feature simple, stay within PLAN.md, and then summarize what changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		options.workerResults.push({
			phase: {
				id: `merged-result-fix-${stats.mergedResultVerificationRuns}`,
				title: `Merged-result remediation ${stats.mergedResultVerificationRuns}`,
				goal: "Resolve blocking final cleanup/design findings before checker verification",
				instructions: ["Resolve the blocking final cleanup/design findings before the checker loop."],
				dependsOn: [],
				touchedPaths: currentChangedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		stats.remediationPasses += 1;
		if (cleanupGate.hard.length > 0) {
			recordQualityFindings(
				stats,
				"cleanup",
				cleanupRun.report.findings.filter((finding) => classifyQualityGateFinding("cleanup", finding) === "hard"),
			);
		}
		if (designGate.hard.length > 0 && designRun) {
			recordQualityFindings(
				stats,
				"design",
				designRun.report.findings.filter((finding) => classifyQualityGateFinding("design", finding) === "hard"),
			);
		}
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: [
				"Completed one-shot final holistic remediation before the checker loop.",
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		currentChangedFiles = await detectChangedFiles(options.cwd, options.exec);
	}

	const checkerLoop = await runCheckerLoop({
		cwd: options.cwd,
		tempDir: options.tempDir,
		planPath: options.planPath,
		agentFiles: reviewAgentFiles,
		checkerPrompt: options.checkerPrompt,
		workerPrompt: options.workerPrompt,
		designWorkerPrompt: options.designWorkerPrompt,
		decomposition: options.decomposition,
		workerResults: options.workerResults,
		changedFiles: currentChangedFiles,
		exec: options.exec,
		primaryModel: options.primaryModel,
		checkerModels: options.checkerModels,
		thinkingLevel: options.thinkingLevel,
		onUpdate: options.onUpdate,
		onStageChange: options.onStageChange,
		resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		holisticSoftFindings,
		promptForHardGateChoice: options.promptForHardGateChoice,
	});
	mergeWorkflowQualityStats(stats, checkerLoop.stats);
	return {
		outcome: checkerLoop.outcome,
		stopReason: checkerLoop.stopReason,
		changedFiles: checkerLoop.changedFiles,
		checkerRun: checkerLoop.checkerRun,
		stats,
		acceptedResidualSoftFindings: [...holisticSoftFindings, ...checkerLoop.acceptedResidualSoftFindings],
		blockingHardFindings: checkerLoop.blockingHardFindings,
	};
}

function renderQualitySuiteRemediationContext(options: {
	round: number;
	maxRounds: number;
	decision: QualitySuiteRoundDecision;
	changedFiles: string[];
	cleanupRun: SpecialistReviewRun;
	designRun: SpecialistReviewRun | null;
	checkerRun: CheckerSuiteResult;
}): string {
	return trimBlock(
		[
			"## Quality suite remediation",
			"",
			`- round: ${options.round}/${options.maxRounds}`,
			`- triggered stages: ${options.decision.triggerStages.length > 0 ? options.decision.triggerStages.join(", ") : "none"}`,
			`- changed files: ${options.changedFiles.length > 0 ? options.changedFiles.join(", ") : "none detected"}`,
			"",
			renderFindingReportSummary("Cleanup findings", options.cleanupRun.report),
			"",
			options.designRun
				? renderFindingReportSummary("Design review findings", options.designRun.report)
				: trimBlock(["## Design review", "", "Skipped for this round because no design-sensitive signals were detected."].join("\n")),
			"",
			renderFindingReportSummary("Checker findings", options.checkerRun.report),
		].join("\n"),
	);
}

async function runQualitySuite(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	workerPrompt: string;
	designWorkerPrompt: string;
	cleanupPrompt: string;
	designReviewPrompt: string;
	checkerPrompt: string;
	decomposition: DecompositionPlan;
	workerResults: WorkerPhaseResult[];
	changedFiles: string[];
	exec: ExecLike;
	primaryModel?: string;
	checkerModels: string[];
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
	onStageChange?: (nodeId: WorkflowNodeId) => void;
	suiteId: string;
	verificationReason: string;
	designContextText?: string;
	promptForSoftGateChoice?: (decision: QualitySuiteRoundDecision) => Promise<QualitySuiteSoftGateChoice>;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
}): Promise<QualitySuiteResult> {
	let currentChangedFiles = [...options.changedFiles];
	let designSignalFindings: CheckerReport["findings"] = [];
	const stats = createWorkflowQualityStats();
	stats.mergedResultVerificationRuns += 1;
	if (options.verificationReason.trim()) stats.mergedResultVerificationReasons.add(options.verificationReason.trim());
	const roundHistory: QualitySuiteRoundSnapshot[] = [];
	let manualContinueBudget = 0;
	let cleanupRun!: SpecialistReviewRun;
	let designRun: SpecialistReviewRun | null = null;
	let checkerRun!: CheckerSuiteResult;

	for (let round = 1; round <= QUALITY_SUITE_MAX_ROUNDS + QUALITY_SUITE_MAX_EXTRA_ROUNDS + manualContinueBudget; round++) {
		const roundBudgetTotal = QUALITY_SUITE_MAX_ROUNDS + QUALITY_SUITE_MAX_EXTRA_ROUNDS + manualContinueBudget;
		const roundLabel = `Quality round ${round}/${roundBudgetTotal}`;
		const phaseContext = options.workerResults.map((result) => result.phase);
		const designRequired = shouldRunDesignReview({
			phases: phaseContext,
			changedFiles: currentChangedFiles,
			discrepancyText: options.designContextText,
			findings: designSignalFindings,
		});

		options.onStageChange?.("cleanup");
		emitWorkflowUpdate(options.onUpdate, {
			type: "cleanup-started",
			stage: "cleanup",
			lines: [
				`${roundLabel}: running cleanup audit`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				designReviewNeeded: designRequired,
				note: `${roundLabel} cleanup audit started`,
			},
		});
		cleanupRun = await runSpecialistReview({
			name: `cleanup-${options.suiteId}-round-${round}`,
			prefix: `cleanup-${options.suiteId}-round-${round}`,
			reviewCommand: "cleanup-audit",
			systemPrompt: options.cleanupPrompt,
			prompt: "Audit the implementation for concrete cleanup work. Review the changed files, the worker summaries, and the relevant AGENTS.md guidance. Return JSON only.",
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: options.agentFiles,
			decomposition: options.decomposition,
			workerResults: options.workerResults,
			changedFiles: currentChangedFiles,
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		stats.cleanupRuns += 1;
		updateLegacyCleanupEvidence(stats, cleanupRun.report.findings);
		emitWorkflowUpdate(options.onUpdate, {
			type: "cleanup-completed",
			stage: "cleanup",
			lines: [
				`${roundLabel}: cleanup audit found ${cleanupRun.report.findings.length} finding(s).`,
				cleanupRun.report.findings.length > 0
					? `Top findings: ${summarizeFindingsList(cleanupRun.report.findings).join(" • ")}`
					: `Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				designReviewNeeded: designRequired,
				note: `${roundLabel} cleanup audit completed`,
			},
		});

		if (designRequired) {
			options.onStageChange?.("design");
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-started",
				stage: "design",
				lines: [
					`${roundLabel}: running design review`,
					`Changed files: ${summarizePaths(currentChangedFiles)}`,
				],
				context: {
					changedFiles: currentChangedFiles,
					changedFilesSummary: summarizePaths(currentChangedFiles),
					qualityRound: round,
					qualityRounds: roundBudgetTotal,
					designReviewNeeded: true,
					note: `${roundLabel} design review started`,
				},
			});
			designRun = await runSpecialistReview({
				name: `design-${options.suiteId}-round-${round}`,
				prefix: `design-${options.suiteId}-round-${round}`,
				reviewCommand: "design-review",
				systemPrompt: options.designReviewPrompt,
				prompt: "Review the implementation for design quality. Review the changed files, the worker summaries, and the relevant AGENTS.md guidance. Return JSON only.",
				cwd: options.cwd,
				tempDir: options.tempDir,
				planPath: options.planPath,
				agentFiles: options.agentFiles,
				decomposition: options.decomposition,
				workerResults: options.workerResults,
				changedFiles: currentChangedFiles,
				model: options.primaryModel,
				thinkingLevel: options.thinkingLevel,
			});
			stats.designReviewRuns += 1;
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-completed",
				stage: "design",
				lines: [
					`${roundLabel}: design review found ${designRun.report.findings.length} finding(s).`,
					designRun.report.findings.length > 0
						? `Top findings: ${summarizeFindingsList(designRun.report.findings).join(" • ")}`
						: `Changed files: ${summarizePaths(currentChangedFiles)}`,
				],
				context: {
					changedFiles: currentChangedFiles,
					changedFilesSummary: summarizePaths(currentChangedFiles),
					qualityRound: round,
					qualityRounds: roundBudgetTotal,
					designReviewNeeded: true,
					note: `${roundLabel} design review completed`,
				},
			});
		} else {
			designRun = null;
			stats.designReviewSkips += 1;
			emitWorkflowUpdate(options.onUpdate, {
				type: "design-skipped",
				stage: "design",
				lines: [
					`${roundLabel}: skipping design review`,
					"No design-sensitive signals were detected for the current code.",
				],
				context: {
					changedFiles: currentChangedFiles,
					changedFilesSummary: summarizePaths(currentChangedFiles),
					qualityRound: round,
					qualityRounds: roundBudgetTotal,
					designReviewNeeded: false,
					note: `${roundLabel} design review not needed`,
				},
			});
		}

		options.onStageChange?.("checker");
		emitWorkflowUpdate(options.onUpdate, {
			type: "checker-started",
			stage: "checker",
			lines: [
				`${roundLabel}: running checker review with ${options.checkerModels.length > 0 ? options.checkerModels.join(", ") : "default"}`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				checkerModels: options.checkerModels,
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `${roundLabel} checker review started`,
			},
		});
		checkerRun = await runCheckerSuite({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: options.agentFiles,
			checkerPrompt: options.checkerPrompt,
			decomposition: options.decomposition,
			workerResults: options.workerResults,
			changedFiles: currentChangedFiles,
			checkerModels: options.checkerModels,
			exec: options.exec,
			thinkingLevel: options.thinkingLevel,
			onUpdate: options.onUpdate,
			resolveAgentsCheckExecutionPolicy: options.resolveAgentsCheckExecutionPolicy,
		});
		stats.checkerRuns += 1;
		stats.agentsCheckResults.push(...checkerRun.agentsCheckResults);
		emitWorkflowUpdate(options.onUpdate, {
			type: "checker-completed",
			stage: "checker",
			lines: [
				`${roundLabel}: checker finished with ${checkerRun.report.findings.length} finding(s) across ${checkerRun.modelRuns.length} model review(s).`,
				checkerRun.report.findings.length > 0
					? `Top findings: ${summarizeCheckerFindings(checkerRun.report).join(" • ")}`
					: `Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			context: {
				checkerModels: checkerRun.modelRuns.map((run) => run.model),
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `${roundLabel} checker review completed`,
			},
		});

		const remediationFindings = [
			...cleanupRun.report.findings,
			...(designRun?.report.findings ?? []),
			...checkerRun.report.findings,
		];
		const decision = decideQualitySuiteRound({
			round,
			maxRounds: QUALITY_SUITE_MAX_ROUNDS,
			extraRounds: QUALITY_SUITE_MAX_EXTRA_ROUNDS,
			history: roundHistory,
			cleanupReport: cleanupRun.report,
			designRequired,
			designReport: designRun?.report ?? null,
			checkerReport: checkerRun.report,
		});
		if (decision.action === "pass") {
			return {
				outcome: "pass",
				acceptedResidualSoftFindings: [],
				blockingHardFindings: [],
				changedFiles: currentChangedFiles,
				cleanupRun,
				designRun,
				checkerRun,
				stats,
			};
		}

		designSignalFindings = remediationFindings;
		if (decision.action === "fail") {
			options.onStageChange?.(decision.triggerStages[0] ?? "checker");
			throw new Error(decision.message || "Quality suite failed to converge.");
		}
		if (decision.action === "prompt") {
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "checker",
				lines: [
					decision.message || "Only soft quality findings remain.",
					`Soft findings: ${decision.softGateFindings.length}`,
				],
				context: {
					changedFiles: currentChangedFiles,
					changedFilesSummary: summarizePaths(currentChangedFiles),
					qualityRound: round,
					qualityRounds: roundBudgetTotal,
					note: "Awaiting quality-suite soft-gate decision",
				},
			});
			if (!options.promptForSoftGateChoice) {
				throw new Error(
					decision.message ||
						"Quality suite stopped with soft findings still remaining, and no interactive prompt path is available.",
				);
			}
			const choice = await options.promptForSoftGateChoice(decision);
			if (choice === "Accept remaining soft findings and continue") {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "checker",
					lines: [
						`Accepting ${decision.softGateFindings.length} residual soft quality finding(s) and continuing to validator.`,
					],
					context: {
						changedFiles: currentChangedFiles,
						changedFilesSummary: summarizePaths(currentChangedFiles),
						qualityRound: round,
						qualityRounds: roundBudgetTotal,
						note: "Residual soft findings accepted",
					},
				});
				return {
					outcome: "accepted-soft",
					acceptedResidualSoftFindings: decision.softGateFindings,
					blockingHardFindings: decision.hardGateFindings,
					changedFiles: currentChangedFiles,
					cleanupRun,
					designRun,
					checkerRun,
					stats,
				};
			}
			if (choice === "Reformulate in discovery mode") {
				throw new QualitySuiteReformulateError({
					summary: buildQualityReformulationSummary({
						changedFiles: currentChangedFiles,
						checks: checkerRun.results,
						checker: checkerRun.report,
						quality: summarizeWorkflowQualityStats(stats),
						softFindings: decision.softGateFindings,
						hardFindings: decision.hardGateFindings,
					}),
					reformulationPrompt: buildQualityReformulationPrompt(decision.softGateFindings),
				});
			}
			manualContinueBudget += 1;
			if (decision.message) {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "fix",
					lines: [decision.message, `Manual remediation override granted. New round budget: ${roundBudgetTotal + 1}.`],
					context: {
						changedFiles: currentChangedFiles,
						changedFilesSummary: summarizePaths(currentChangedFiles),
						qualityRound: round,
						qualityRounds: roundBudgetTotal + 1,
						note: "Continuing quality remediation after soft-gate prompt",
					},
				});
			}
		}

		roundHistory.push(decision.snapshot);
		const remediationPromptSelection = pickRemediationPrompt({
			workerPrompt: options.workerPrompt,
			designWorkerPrompt: options.designWorkerPrompt,
			phases: phaseContext,
			changedFiles: currentChangedFiles,
			findings: remediationFindings,
			discrepancyText: options.designContextText,
		});
		const remediationSummaryItems = summarizeFindingsList(remediationFindings);
		for (const stage of decision.triggerStages) {
			emitLoopTraversal(
				options.onUpdate,
				QUALITY_STAGE_FIX_EDGE[stage],
				"fix",
				[
					`${roundLabel}: ${stage} requested remediation.`,
					remediationSummaryItems.length > 0
						? `Top findings: ${remediationSummaryItems.join(" • ")}`
						: `Changed files: ${summarizePaths(currentChangedFiles)}`,
				],
				{
					changedFiles: currentChangedFiles,
					changedFilesSummary: summarizePaths(currentChangedFiles),
					qualityRound: round,
					qualityRounds: roundBudgetTotal,
					note: `${roundLabel} ${stage} requested remediation`,
				},
			);
		}

		options.onStageChange?.("fix");
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-started",
			stage: "fix",
			lines: [
				`${roundLabel}: applying ${remediationFindings.length} quality finding(s).`,
				`Stages: ${decision.triggerStages.join(", ")}`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: options.agentFiles,
			touchedPaths: currentChangedFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: `${options.suiteId}-quality-fix-round-${round}`,
			contextMarkdown: renderQualitySuiteRemediationContext({
				round,
				maxRounds: roundBudgetTotal,
				decision,
				changedFiles: currentChangedFiles,
				cleanupRun,
				designRun,
				checkerRun,
			}),
			prompt:
				"Apply the attached cleanup, design review, and checker findings now. Resolve every concrete issue, keep the implementation simple, remove superseded code when relevant, and then summarize what you changed.",
			model: options.primaryModel,
			thinkingLevel: options.thinkingLevel,
		});
		options.workerResults.push({
			phase: {
				id: `${options.suiteId}-quality-fix-round-${round}`,
				title: `${options.suiteId} quality remediation round ${round}`,
				goal: "Resolve cleanup, design review, and checker findings",
				instructions: [`Resolve the quality-suite findings from round ${round}.`],
				dependsOn: [],
				touchedPaths: currentChangedFiles,
				parallelSafe: false,
				designSensitive: remediationPromptSelection.designSensitive,
			},
			summary: fixSummary,
		});
		stats.remediationPasses += 1;
		for (const stage of decision.triggerStages) {
			if (stage === "cleanup") recordQualityFindings(stats, stage, cleanupRun.report.findings);
			if (stage === "design") recordQualityFindings(stats, stage, designRun?.report.findings ?? []);
			if (stage === "checker") recordQualityFindings(stats, stage, checkerRun.report.findings);
		}
		emitWorkflowUpdate(options.onUpdate, {
			type: "fix-completed",
			stage: "fix",
			lines: [
				`${roundLabel}: completed quality remediation.`,
				`Worker: ${remediationPromptSelection.promptLabel}`,
			],
			context: {
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});

		currentChangedFiles = await detectChangedFiles(options.cwd, options.exec);
		emitLoopTraversal(
			options.onUpdate,
			"fix->cleanup",
			"cleanup",
			[
				`${roundLabel}: restarting the quality suite from cleanup.`,
				`Changed files: ${summarizePaths(currentChangedFiles)}`,
			],
			{
				changedFiles: currentChangedFiles,
				changedFilesSummary: summarizePaths(currentChangedFiles),
				qualityRound: round,
				qualityRounds: roundBudgetTotal,
				note: `${roundLabel} restarting quality suite from cleanup`,
			},
		);
	}

	throw new Error(`Quality suite exhausted ${QUALITY_SUITE_MAX_ROUNDS + QUALITY_SUITE_MAX_EXTRA_ROUNDS + manualContinueBudget} round(s).`);
}

export async function runToolboxImplementationWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: WorkflowOptions,
): Promise<WorkflowSummary> {
	let originalRepoRoot = findRepoRoot(ctx.cwd);
	const exec = makeExec(pi);
	let runWorkspace: ManagedWorkspace | undefined;
	let initialSeededChangedFiles: string[] = [];
	let workspaceRepoRoot = "";
	let workspaceRelativeCwd = "";
	let workflowCwd = "";
	let tempDir = "";
	let preserveRunWorkspace = false;
	const workflowModels = resolveWorkflowModels(ctx);
	const primaryModel = workflowModels.primary;
	const checkerModels = workflowModels.checkers;
	const thinkingLevel = pi.getThinkingLevel();
	const resumeState = options.resumeState ? structuredClone(options.resumeState) : undefined;

	const reviewModels = checkerModels.length > 0 ? checkerModels : primaryModel ? [primaryModel] : [];
	let activeNode: WorkflowNodeId | undefined;
	let cleanupReportStage: "complete" | "failed" = "failed";
	let runWorkspaceIntegrated = false;
	const agentsCheckExecutionPolicies = new Map<string, AgentsCheckExecutionPolicy>();
	let handleRunWorkspaceIntegration: (() => Promise<void>) | undefined;
	const previousWorkflowSubagentUsageSink = currentWorkflowSubagentUsageSink;
	currentWorkflowSubagentUsageSink = options.onUsage;

	try {
		if (resumeState) {
			const currentRepoRoot = findRepoRoot(ctx.cwd);
			if (resolve(currentRepoRoot) !== resolve(resumeState.originalRepoRoot)) {
				throw new Error(
					`The saved resumable workspace belongs to ${resumeState.originalRepoRoot}, but the current checkout is ${currentRepoRoot}. Resume it from the original repository checkout instead.`,
				);
			}
			originalRepoRoot = resumeState.originalRepoRoot;
			runWorkspace = await reviveManagedWorkspace({ exec, state: resumeState.workspace });
			initialSeededChangedFiles = [...runWorkspace.seededChangedFiles];
			await runWorkspace.refresh();
			workspaceRepoRoot = runWorkspace.repoRoot;
			workspaceRelativeCwd = runWorkspace.sourceRelativeCwd;
			workflowCwd = resolve(runWorkspace.cwd, workspaceRelativeCwd);
			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-start",
				stage: "starting",
				lines: [
					`Resuming a stopped ${resumeState.workflowMode} sub-agent workflow in the preserved isolated workspace.`,
					`Workspace: ${runWorkspace.kind} ${runWorkspace.workspaceName} @ ${runWorkspace.cwd}`,
					`Carried-over workspace changes: ${initialSeededChangedFiles.length > 0 ? summarizePaths(initialSeededChangedFiles) : "none"}`,
					`Primary model: ${primaryModel ?? "default"}`,
					`Checker models: ${reviewModels.length > 0 ? reviewModels.join(", ") : primaryModel ?? "default"}`,
				],
				context: {
					checkerModels: reviewModels,
					note: "Resumed sub-agent implementation workflow starting",
				},
			});
		} else {
			const managedRunWorkspace = await createManagedWorkspace({
				exec,
				sourceCwd: ctx.cwd,
				label: "run",
			});
			runWorkspace = managedRunWorkspace.workspace;
			initialSeededChangedFiles = managedRunWorkspace.seededChangedFiles;
			await runWorkspace.refresh();
			workspaceRepoRoot = runWorkspace.repoRoot;
			workspaceRelativeCwd = runWorkspace.sourceRelativeCwd;
			workflowCwd = resolve(runWorkspace.cwd, workspaceRelativeCwd);

			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-start",
				stage: "starting",
				lines: [
					options.rawPrompt?.trim()
						? "Synthesizing a lightweight plan in an isolated workspace."
						: `Using ${options.planPath} as the approved source of truth in an isolated workspace.`,
					`Workspace: ${runWorkspace.kind} ${runWorkspace.workspaceName} @ ${runWorkspace.cwd}`,
					`Seeded source checkout changes: ${initialSeededChangedFiles.length > 0 ? summarizePaths(initialSeededChangedFiles) : "none"}`,
					`Primary model: ${primaryModel ?? "default"}`,
					`Checker models: ${reviewModels.length > 0 ? reviewModels.join(", ") : primaryModel ?? "default"}`,
				],
				context: {
					checkerModels: reviewModels,
					note: "Sub-agent implementation workflow starting",
				},
			});
		}

		const originalCheckoutBaseline = await createWorkspaceSnapshot({
			cwd: originalRepoRoot,
			touchedPaths: [],
			seededChangedFiles: initialSeededChangedFiles,
		});
		const originalCheckoutRevision = await captureWorkspaceRevision(originalRepoRoot, exec);
		tempDir = await mkdtemp(join(runWorkspace.cleanupRoot, resumeState ? "resume-context-" : "context-"));
		const [implementationPlannerPrompt, decomposerPrompt, workerPrompt, designWorkerPrompt, cleanupPrompt, designReviewPrompt, checkerPrompt, validatorPrompt] =
			await Promise.all([
				readBundledPrompt("implementation-planner"),
				readBundledPrompt("decomposer"),
				readBundledPrompt("worker"),
				readBundledPrompt("design-worker"),
				readBundledPrompt("cleanup-auditor"),
				readBundledPrompt("design-reviewer"),
				readBundledPrompt("checker"),
				readBundledPrompt("validator"),
			]);
		const agentFiles = await existingFiles(discoverAncestorDocumentPaths(workflowCwd, workspaceRepoRoot, "AGENTS.md"));
		const materializedPlan = resumeState
			? {
				planPath: await materializeResumedWorkflowPlan(tempDir, resumeState.planDocument),
				label: "preserved stopped-workflow plan",
			}
			: await materializeWorkflowPlan({
					cwd: workflowCwd,
					tempDir,
					agentFiles,
					planPath: options.planPath,
					rawPrompt: options.rawPrompt,
					plannerPrompt: implementationPlannerPrompt,
					extraInstructions: options.extraInstructions,
					model: primaryModel,
					thinkingLevel,
				});
		const planPath = materializedPlan.planPath;
		const planDocument = resumeState?.planDocument ?? (await readFile(planPath, "utf8"));
		const resolveAgentsCheckExecutionPolicy = async (
			commands: AgentsCheckCommand[],
		): Promise<AgentsCheckExecutionPolicy> => {
			const commandSetKey = agentsCheckCommandSetKey(commands);
			const cachedPolicy = agentsCheckExecutionPolicies.get(commandSetKey);
			if (cachedPolicy) return cachedPolicy;
			const policy = await requestAgentsCheckExecutionPolicy(ctx, commands);
			agentsCheckExecutionPolicies.set(commandSetKey, policy);
			return policy;
		};
		const integrateRunWorkspace = async (): Promise<void> => {
			if (runWorkspaceIntegrated) return;
			await runWorkspace.refresh();
			const currentOriginalCheckoutRevision = await captureWorkspaceRevision(originalRepoRoot, exec);
			if (workspaceRevisionChanged(originalCheckoutRevision, currentOriginalCheckoutRevision)) {
				throw new Error(
					`The original checkout moved to a different ${currentOriginalCheckoutRevision.kind} revision while the isolated workspace was running. Update or rebase the checkout, then rerun instead of auto-integrating stale workspace output.`,
				);
			}
			const finalIntegration = await integrateWorkspaceChanges({
				childCwd: runWorkspace.repoRoot,
				parentCwd: originalRepoRoot,
				baseline: originalCheckoutBaseline,
				exec,
				allowPartialIntegration: false,
			});
			if (finalIntegration.conflictingFiles.length > 0) {
				throw new Error(
					`The original checkout changed while the isolated workspace was running. Resolve these files manually and rerun: ${finalIntegration.conflictingFiles.join(", ")}`,
				);
			}
			runWorkspaceIntegrated = true;
		};
		handleRunWorkspaceIntegration = integrateRunWorkspace;
		const workflowMode = resumeState?.workflowMode ?? options.workflowMode ?? "fast";
		const effectiveExtraInstructions = resumeState?.extraInstructions ?? options.extraInstructions;
		const planInfoPath = await writeTempContextFile(
			tempDir,
			"workflow-instructions.md",
			[
				"## Workflow instructions",
				"",
				`- original repo root: ${originalRepoRoot}`,
				`- isolated workspace root: ${workspaceRepoRoot}`,
				`- workflow cwd: ${workflowCwd}`,
				`- workflow cwd relative to repo root: ${workspaceRelativeCwd}`,
				`- seeded source checkout changes: ${initialSeededChangedFiles.length > 0 ? initialSeededChangedFiles.join(", ") : "none"}`,
				`- approved plan source: ${materializedPlan.label}`,
				`- workflow mode: ${workflowMode.trim()}`,
				...(resumeState ? ["- resumed from preserved isolated workspace: yes"] : []),
				...(effectiveExtraInstructions.trim()
					? ["", "## Additional instructions", "", effectiveExtraInstructions.trim()]
					: []),
			].join("\n"),
		);
		const setActiveNode = (nodeId: WorkflowNodeId): void => {
			activeNode = nodeId;
		};
		if (resumeState) {
			const resumedWorkerResults = cloneWorkerResults(resumeState.workerResults);
			const resumedDecomposition = cloneDecompositionPlan(resumeState.decomposition);
			if (workflowMode === "fast") {
				const result = await runResumedFastImplementationWorkflow({
					cwd: workflowCwd,
					tempDir,
					planPath,
					agentFiles,
					workerPrompt,
					designWorkerPrompt,
					checkerPrompt,
					validatorPrompt,
					extraInstructions: effectiveExtraInstructions,
					decomposition: resumedDecomposition,
					workerResults: resumedWorkerResults,
					exec,
					primaryModel,
					checkerModels: reviewModels,
					thinkingLevel,
					onUpdate: options.onUpdate,
					onStageChange: setActiveNode,
					resolveAgentsCheckExecutionPolicy,
					promptForHardGateChoice: ctx.hasUI
						? async (decision) => await promptForFinalCheckerHardGateChoice(ctx, decision)
						: undefined,
				});
				if (result.decision === "done") {
					await integrateRunWorkspace();
					emitWorkflowUpdate(options.onUpdate, {
						type: "workflow-completed",
						stage: "complete",
						lines: [
							"Resumed fast sub-agent implementation workflow finished.",
							`Changed files: ${summarizePaths(await detectChangedFiles(workflowCwd, exec))}`,
						],
						context: {
							note: "Resumed fast workflow completed",
						},
					});
				} else {
					preserveRunWorkspace = true;
					emitWorkflowUpdate(options.onUpdate, {
						type: "workflow-completed",
						stage: "complete",
						lines: [
							"Resumed fast sub-agent implementation workflow stopped with blockers still remaining.",
							"The isolated workspace result was not applied to the original checkout.",
						],
						context: {
							note: "Resumed fast workflow stopped gracefully without integrating the isolated workspace",
						},
					});
				}
				cleanupReportStage = "complete";
				return {
					decision: result.decision,
					summary: result.summary,
					resumableState:
						result.decision === "stopped"
							? buildResumableImplementationState({
								runWorkspace,
								originalRepoRoot,
								workflowMode,
								planDocument,
								extraInstructions: effectiveExtraInstructions,
								decomposition: resumedDecomposition,
								workerResults: result.workerResults ?? resumedWorkerResults,
							})
							: undefined,
				};
			}

			const verificationPass = await runResumedStrictImplementationWorkflow({
				cwd: workflowCwd,
				tempDir,
				planPath,
				agentFiles,
				workerPrompt,
				designWorkerPrompt,
				cleanupPrompt,
				designReviewPrompt,
				checkerPrompt,
				validatorPrompt,
				decomposition: resumedDecomposition,
				workerResults: resumedWorkerResults,
				exec,
				primaryModel,
				checkerModels: reviewModels,
				thinkingLevel,
				onUpdate: options.onUpdate,
				onStageChange: setActiveNode,
				resolveAgentsCheckExecutionPolicy,
				promptForHardGateChoice: ctx.hasUI
					? async (decision) => await promptForFinalCheckerHardGateChoice(ctx, decision)
					: undefined,
				integrateRunWorkspace,
			});
			if (verificationPass.decision === "stopped") {
				preserveRunWorkspace = true;
				emitWorkflowUpdate(options.onUpdate, {
					type: "workflow-completed",
					stage: "complete",
					lines: [
						"Resumed strict sub-agent implementation workflow stopped with blockers still remaining.",
						"The isolated workspace result was not applied to the original checkout.",
					],
					context: {
						note: "Resumed strict workflow stopped gracefully without integrating the isolated workspace",
					},
				});
			} else {
				emitWorkflowUpdate(options.onUpdate, {
					type: "workflow-completed",
					stage: "complete",
					lines: [
						"Resumed strict sub-agent implementation workflow finished.",
						`Changed files: ${summarizePaths(await detectChangedFiles(workflowCwd, exec))}`,
					],
					context: {
						note: "Resumed strict workflow completed",
					},
				});
			}
			cleanupReportStage = "complete";
			return {
				decision: verificationPass.decision,
				summary: verificationPass.summary,
				resumableState:
					verificationPass.decision === "stopped"
						? buildResumableImplementationState({
							runWorkspace,
							originalRepoRoot,
							workflowMode,
							planDocument,
							extraInstructions: effectiveExtraInstructions,
							decomposition: resumedDecomposition,
							workerResults: verificationPass.workerResults ?? resumedWorkerResults,
						})
						: undefined,
			};
		}

		if (workflowMode === "fast") {
			const result = await runFastImplementationWorkflow({
				cwd: workflowCwd,
				tempDir,
				planPath,
				agentFiles,
				workerPrompt,
				designWorkerPrompt,
				checkerPrompt,
				validatorPrompt,
				extraInstructions: effectiveExtraInstructions,
				exec,
				primaryModel,
				checkerModels: reviewModels,
				thinkingLevel,
				onUpdate: options.onUpdate,
				onStageChange: setActiveNode,
				resolveAgentsCheckExecutionPolicy,
				promptForHardGateChoice: ctx.hasUI
					? async (decision) => await promptForFinalCheckerHardGateChoice(ctx, decision)
					: undefined,
			});
			if (result.decision === "done") {
				await integrateRunWorkspace();
				emitWorkflowUpdate(options.onUpdate, {
					type: "workflow-completed",
					stage: "complete",
					lines: [
						"Fast sub-agent implementation workflow finished.",
						`Changed files: ${summarizePaths(await detectChangedFiles(workflowCwd, exec))}`,
					],
					context: {
						note: "Fast workflow completed",
					},
				});
				cleanupReportStage = "complete";
				return result;
			}
			preserveRunWorkspace = true;
			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-completed",
				stage: "complete",
				lines: [
					"Fast sub-agent implementation workflow stopped with blockers still remaining.",
					"The isolated workspace result was not applied to the original checkout.",
				],
				context: {
					note: "Fast workflow stopped gracefully without integrating the isolated workspace",
				},
			});
			cleanupReportStage = "complete";
			return {
				decision: result.decision,
				summary: result.summary,
				resumableState: buildResumableImplementationState({
					runWorkspace,
					originalRepoRoot,
					workflowMode,
					planDocument,
					extraInstructions: effectiveExtraInstructions,
					decomposition: result.decomposition ?? createFastModeDecomposition(planDocument),
					workerResults: result.workerResults ?? [],
				}),
			};
		}

		activeNode = "decomposer";
		emitWorkflowUpdate(options.onUpdate, {
			type: "decomposer-started",
			stage: "decomposer",
			lines: [
				"Breaking the approved plan into implementation phases...",
				`Primary model: ${primaryModel ?? "default"}`,
				`Checker models: ${reviewModels.length > 0 ? reviewModels.join(", ") : primaryModel ?? "default"}`,
			],
			context: {
				checkerModels: reviewModels,
				note: "Plan decomposition started",
			},
		});
		const decomposition = await runStructuredStage({
			name: "decomposer",
			systemPrompt: decomposerPrompt,
			prompt: "Break the attached approved PLAN.md into actionable implementation phases for the sub-agent workflow. Return JSON only.",
			files: [planPath, ...agentFiles, planInfoPath],
			tools: READ_ONLY_SUBAGENT_TOOLS,
			cwd: workflowCwd,
			model: primaryModel,
			thinkingLevel,
			tempDir,
			parse: parseDecompositionPlan,
		});
		emitWorkflowUpdate(options.onUpdate, {
			type: "decomposer-completed",
			phases: decomposition.phases,
			stage: "decomposer",
			lines: [
				`Decomposition finished with ${decomposition.phases.length} phase(s).`,
				decomposition.notes.length > 0 ? `Notes: ${decomposition.notes[0]}` : "No decomposer notes.",
			],
			context: {
				phaseCount: decomposition.phases.length,
				note: "Plan decomposition completed",
			},
		});

		const batches = computeExecutionBatches(decomposition.phases);
		emitWorkflowUpdate(options.onUpdate, {
			type: "batches-computed",
			phases: decomposition.phases,
			batches,
			stage: "implementation",
			lines: [
				`Prepared ${batches.length} implementation batch(es) across ${decomposition.phases.length} phase(s).`,
				...batches.slice(0, 3).map((batch, batchIndex) => `Batch ${batchIndex + 1}: ${batch.map((phase) => phase.title).join(" | ")}`),
			],
			context: {
				batchCount: batches.length,
				phaseCount: decomposition.phases.length,
				note: "Implementation batches ready",
			},
		});

		let resolvedChildIntegrationConflicts = false;
		const workerResults: WorkerPhaseResult[] = [];
		const workflowQualityStats = createWorkflowQualityStats();
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			activeNode = "implementation";
			const batch = batches[batchIndex];
			const batchTouchedPaths = [...new Set(batch.flatMap((phase) => phase.touchedPaths))];
			emitWorkflowUpdate(options.onUpdate, {
				type: "batch-started",
				batchIndex,
				stage: "worker",
				lines: [
					`Running implementation batch ${batchIndex + 1}/${batches.length}`,
					batch.map((phase) => `${phase.id}: ${phase.title}`).join(" | "),
				],
				context: {
					batchIndex,
					batchCount: batches.length,
					touchedPaths: batchTouchedPaths,
					touchedPathsSummary: summarizePaths(batchTouchedPaths),
					note: `Implementation batch ${batchIndex + 1} started`,
				},
			});
			const runBatchPhase = async (phase: DecompositionPhase, cwd: string, priorWorkerResults: WorkerPhaseResult[]): Promise<WorkerPhaseResult[]> => {
				const phaseResult = await runWorkerPhase({
					cwd,
					tempDir,
					planPath,
					agentFiles,
					workerPrompt,
					designWorkerPrompt,
					phase,
					batchIndex,
					batchCount: batches.length,
					extraInstructions: effectiveExtraInstructions,
					model: primaryModel,
					thinkingLevel,
					onUpdate: options.onUpdate,
				});
				const phaseWorkerResults = [...priorWorkerResults, phaseResult];
				const phaseChangedFiles = await detectChangedFiles(cwd, exec);
				const followThrough = await runPhaseFollowThroughLoop({
					cwd,
					tempDir,
					planPath,
					agentFiles,
					workerPrompt,
					designWorkerPrompt,
					cleanupPrompt,
					designReviewPrompt,
					decomposition,
					workerResults: phaseWorkerResults,
					phase: phaseResult.phase,
					changedFiles: phaseChangedFiles,
					exec,
					primaryModel,
					thinkingLevel,
					onUpdate: options.onUpdate,
					onStageChange: setActiveNode,
				});
				mergeWorkflowQualityStats(workflowQualityStats, followThrough.stats);
				return phaseWorkerResults.slice(priorWorkerResults.length);
			};
			const phaseResults: WorkerPhaseResult[] = [];
			if (batch.some((phase) => phase.parallelSafe)) {
				const childWorkspaces: ManagedWorkspace[] = [];
				const childRunResults = await Promise.allSettled(
					batch.map(async (phase) => {
						const child = await createChildWorkspace({
							exec,
							parentCwd: runWorkspace.repoRoot,
							label: phase.id,
							touchedPaths: phase.touchedPaths,
						});
						childWorkspaces.push(child.workspace);
						await child.workspace.refresh();
						const childWorkflowCwd = resolve(child.workspace.repoRoot, workspaceRelativeCwd);
						return {
							phase,
							child,
							results: await runBatchPhase(phase, childWorkflowCwd, workerResults),
						};
					}),
				);
				try {
					const failedChildRun = childRunResults.find((result) => result.status === "rejected");
					if (failedChildRun?.status === "rejected") throw failedChildRun.reason;
					for (const childRunResult of childRunResults) {
						if (childRunResult.status !== "fulfilled") continue;
						const childRun = childRunResult.value;
						await childRun.child.workspace.refresh();
						await runWorkspace.refresh();
						const integration = await integrateWorkspaceChanges({
							childCwd: childRun.child.workspace.repoRoot,
							parentCwd: runWorkspace.repoRoot,
							baseline: childRun.child.baseline,
							exec,
						});
						if (integration.conflictingFiles.length > 0) {
							resolvedChildIntegrationConflicts = true;
							const summary = await resolveWorkspaceIntegrationConflicts({
								cwd: workflowCwd,
								tempDir,
								planPath,
								agentFiles,
								workerPrompt,
								designWorkerPrompt,
								phase: childRun.phase,
								childWorkspace: childRun.child.workspace,
								baseline: childRun.child.baseline,
								conflictingFiles: integration.conflictingFiles,
								model: primaryModel,
								thinkingLevel,
								onUpdate: options.onUpdate,
							});
							workerResults.push({
								phase: {
									id: `${childRun.phase.id}-integration-conflicts`,
									title: `${childRun.phase.title} integration conflict resolution`,
									goal: "Resolve workspace integration conflicts",
									instructions: [`Resolve workspace integration conflicts for ${childRun.phase.id}.`],
									dependsOn: [childRun.phase.id],
									touchedPaths: integration.conflictingFiles,
									parallelSafe: false,
									designSensitive: childRun.phase.designSensitive,
								},
								summary,
							});
						}
						phaseResults.push(...childRun.results);
					}
				} finally {
					await Promise.allSettled(childWorkspaces.map(async (workspace) => await workspace.cleanup()));
				}
			} else {
				phaseResults.push(...(await runBatchPhase(batch[0], workflowCwd, workerResults)));
			}
			workerResults.push(...phaseResults);
			emitWorkflowUpdate(options.onUpdate, {
				type: "batch-completed",
				batchIndex,
				stage: "worker",
				lines: [
					`Completed implementation batch ${batchIndex + 1}/${batches.length}`,
					`Touched paths: ${summarizePaths(batchTouchedPaths)}`,
				],
				context: {
					batchIndex,
					batchCount: batches.length,
					touchedPaths: batchTouchedPaths,
					touchedPathsSummary: summarizePaths(batchTouchedPaths),
					note: `Implementation batch ${batchIndex + 1} completed`,
				},
			});
		}

		let changedFiles = await detectChangedFiles(workflowCwd, exec);
		let acceptedResidualSoftFindings: QualityGateFindingSummary[] = [];
		let blockingHardFindings: QualityGateFindingSummary[] = [];

		let verificationPass = await runMergedResultVerification({
			cwd: workflowCwd,
			tempDir,
			planPath,
			agentFiles,
			workerPrompt,
			designWorkerPrompt,
			cleanupPrompt,
			designReviewPrompt,
			checkerPrompt,
			decomposition,
			workerResults,
			changedFiles,
			exec,
			primaryModel,
			checkerModels: reviewModels,
			thinkingLevel,
			onUpdate: options.onUpdate,
			onStageChange: setActiveNode,
			verificationReason: resolvedChildIntegrationConflicts
				? "merged implementation result after child-workspace conflict resolution"
				: "merged implementation result",
			resolveAgentsCheckExecutionPolicy,
			promptForHardGateChoice: ctx.hasUI
				? async (decision) => await promptForFinalCheckerHardGateChoice(ctx, decision)
				: undefined,
		});
		mergeWorkflowQualityStats(workflowQualityStats, verificationPass.stats);
		changedFiles = verificationPass.changedFiles;
		acceptedResidualSoftFindings = verificationPass.acceptedResidualSoftFindings;
		blockingHardFindings = verificationPass.blockingHardFindings;
		let checkPass = verificationPass.checkerRun;

		if (verificationPass.outcome === "stopped-hard") {
			const qualitySummary = summarizeWorkflowQualityStats(workflowQualityStats);
			const summary = buildStoppedSummary({
				reason:
					verificationPass.stopReason ??
					"Final checker stopped with hard-blocking findings still remaining after the bounded retry budget.",
				changedFiles,
				checks: checkPass.results,
				checker: checkPass.report,
				quality: qualitySummary,
				workerResults,
				acceptedResidualSoftFindings,
				blockingHardFindings,
			});
			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-completed",
				stage: "complete",
				lines: [
					"Sub-agent implementation workflow stopped with hard blockers still remaining.",
					verificationPass.stopReason ?? "Final checker stopped before the validator ran.",
					"The isolated workspace result was not applied to the original checkout.",
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					note: "Workflow stopped gracefully without integrating the isolated workspace",
				},
			});
			preserveRunWorkspace = true;
			cleanupReportStage = "complete";
			return {
				decision: "stopped",
				summary,
				resumableState: buildResumableImplementationState({
					runWorkspace,
					originalRepoRoot,
					workflowMode,
					planDocument,
					extraInstructions: effectiveExtraInstructions,
					decomposition,
					workerResults,
				}),
			};
		}

		let validation!: ValidationReport;
		let discrepancySummaryItems: string[] = [];
		const runValidatorPass = async (validatorPass: {
			startLine: string;
			startedNote: string;
			completedNote: string;
		}): Promise<void> => {
			activeNode = "validator";
			emitWorkflowUpdate(options.onUpdate, {
				type: "validator-started",
				stage: "validator",
				lines: [
					validatorPass.startLine,
					`Changed files: ${summarizePaths(changedFiles)}`,
					`Checker findings: ${checkPass.report.findings.length}`,
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					checkerModels: checkPass.modelRuns.map((run) => run.model),
					note: validatorPass.startedNote,
				},
			});
			validation = await runValidator({
				cwd: workflowCwd,
				tempDir,
				planPath,
				agentFiles,
				validatorPrompt,
				decomposition,
				workerResults,
				changedFiles,
				checkerReport: checkPass.report,
				checkResults: checkPass.results,
				model: primaryModel,
				thinkingLevel,
			});
			discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
			emitWorkflowUpdate(options.onUpdate, {
				type: "validator-completed",
				stage: "validator",
				lines: [
					`Validator recommendation: ${validation.recommendation}`,
					validation.summary || `${validation.discrepancies.length} discrepancy(s) reported.`,
					...(discrepancySummaryItems.length > 0 ? [`Discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					discrepancyCount: validation.discrepancies.length,
					discrepancySummary: discrepancySummaryItems,
					recommendation: validation.recommendation,
					note: validatorPass.completedNote,
				},
			});
		};

		await runValidatorPass({
			startLine: "Comparing the implementation against PLAN.md.",
			startedNote: "Validator started",
			completedNote: "Validator completed",
		});

		if (validation.discrepancies.length > 0) {
			discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "validator",
				lines: [
					`Validator reported ${validation.discrepancies.length} remaining plan discrepancy(s).`,
					"Keeping the sub-agent workflow bounded: remaining discrepancies are reported in the final summary instead of triggering another implementation loop.",
					...(discrepancySummaryItems.length > 0 ? [`Top discrepancies: ${discrepancySummaryItems.join(" • ")}`] : []),
				],
				context: {
					discrepancyCount: validation.discrepancies.length,
					discrepancySummary: discrepancySummaryItems,
					recommendation: validation.recommendation,
					note: "Validator discrepancies recorded for advisory follow-up",
				},
			});
		}

		await integrateRunWorkspace();
		const summary = buildSummary(
			changedFiles,
			checkPass.results,
			validation,
			checkPass.report,
			summarizeWorkflowQualityStats(workflowQualityStats),
			{
				acceptedResidualSoftFindings,
				blockingHardFindings,
			},
		);
		discrepancySummaryItems = summarizeDiscrepancies(validation.discrepancies);
		emitWorkflowUpdate(options.onUpdate, {
			type: "workflow-completed",
			stage: "complete",
			lines: [
				"Sub-agent implementation workflow finished.",
				`Validator recommendation: ${validation.recommendation}`,
				`Changed files: ${summarizePaths(changedFiles)}`,
			],
			context: {
				changedFiles,
				changedFilesSummary: summarizePaths(changedFiles),
				discrepancyCount: validation.discrepancies.length,
				discrepancySummary: discrepancySummaryItems,
				recommendation: validation.recommendation,
				note: "Workflow completed",
			},
		});
		cleanupReportStage = "complete";
		return {
			decision: "done",
			summary,
		};
	} catch (error) {
		if (error instanceof QualitySuiteReformulateError) {
			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-completed",
				stage: "complete",
				lines: [
					"Implementation paused for discovery reformulation after merged-result quality review.",
					"The isolated workspace result was not applied to the original checkout.",
				],
				context: {
					note: "Workflow handed back to discovery mode without integrating the isolated workspace",
				},
			});
			cleanupReportStage = "complete";
			return {
				decision: "reformulate",
				summary: error.summary,
				reformulationPrompt: error.reformulationPrompt,
			};
		}
		emitWorkflowUpdate(options.onUpdate, {
			type: "workflow-failed",
			message: error instanceof Error ? error.message : String(error),
			nodeId: activeNode,
			stage: "failed",
			lines: [error instanceof Error ? error.message : String(error)],
			context: {
				note: activeNode ? `Workflow failed in ${activeNode}` : "Workflow failed before stage activation",
			},
		});
		throw error;
	} finally {
		currentWorkflowSubagentUsageSink = previousWorkflowSubagentUsageSink;
		await runBestEffortWorkflowCleanup({
			tempDir,
			runWorkspace: preserveRunWorkspace ? undefined : runWorkspace,
			onUpdate: options.onUpdate,
			stage: cleanupReportStage,
		});
	}
}
