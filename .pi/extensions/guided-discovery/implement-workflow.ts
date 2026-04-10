import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { computeExecutionBatches, detectChangedFiles, type ExecLike } from "./changes.ts";
import {
	appendAgentsChecksToCheckerReport,
	collectAgentsCheckCommands,
	runAgentsCheckCommands,
	type AgentsCheckCommand,
	type AgentsCheckExecutionPolicy,
} from "./agents-checks.ts";
import { selectRemainingActionableDiscrepancies } from "./discrepancy-selector.ts";
import {
	discoverAncestorDocumentPaths,
	discoverRelevantGuidance,
	findRepoRoot,
	renderGuidanceSummary,
	type RelevantGuidanceResult,
} from "./guidance.ts";
import { resolveWorkflowModels } from "./models.ts";
import { runSubagent } from "./subagent-runner.ts";
import {
	createChildWorkspace,
	createManagedWorkspace,
	createWorkspaceSnapshot,
	planWorkspaceIntegration,
	syncWorkspaceFiles,
	type ManagedWorkspace,
	type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
	parseCheckerReport,
	parseDecompositionPlan,
	parseValidationReport,
	type CheckerReport,
	type DecompositionPhase,
	type DecompositionPlan,
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
const WORKER_SUBAGENT_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];
export const QUALITY_SUITE_MAX_ROUNDS = 3;

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

type CheckRunSummary = {
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
	modelRuns: CheckerModelRun[];
}

type WorkflowDecision = "done" | "reformulate";
export type WorkerPromptKind = "worker" | "design-worker";
export type QualityStageId = "cleanup" | "design" | "checker";

interface WorkflowOptions {
	planPath?: string;
	rawPrompt?: string;
	extraInstructions: string;
	onUpdate?: (update: WorkflowProgressUpdate) => void;
}

interface WorkerPhaseResult {
	phase: DecompositionPhase;
	summary: string;
}

interface WorkflowSummary {
	decision: WorkflowDecision;
	summary: string;
	reformulationPrompt?: string;
}

export interface ValidationDiscrepancyTriage {
	actionableDiscrepancies: ValidationDiscrepancy[];
	informationalDiscrepancies: ValidationDiscrepancy[];
	autoDiscrepancies: ValidationDiscrepancy[];
	remainingActionableDiscrepancies: ValidationDiscrepancy[];
	attemptedAutoDiscrepancies: ValidationDiscrepancy[];
}

export interface ValidatorDiscrepancyHandlingDecision extends ValidationDiscrepancyTriage {
	action: "continue" | "auto-remediate" | "prompt" | "fail";
	message?: string;
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

export interface QualitySuiteRoundDecision {
	action: "pass" | "remediate" | "fail";
	designReviewStatus: "ran" | "skipped";
	triggerStages: QualityStageId[];
	findingCounts: Record<QualityStageId, number>;
	restartStage?: "cleanup";
	message?: string;
}

interface QualitySuiteResult {
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
	pendingLegacyCleanupFindingSignatures: Set<string>;
	legacyCodeOrFilesRemoved: boolean;
}

interface WorkflowQualitySummary {
	cleanupRuns: number;
	designReviewRuns: number;
	designReviewSkips: number;
	checkerRuns: number;
	remediationPasses: number;
	fixedFindings: Record<QualityStageId, number> & { total: number };
	legacyCodeOrFilesRemoved: boolean;
}

interface ValidationResolutionSummary {
	autoRemediationPasses: number;
	autoRemediatedDiscrepancyIds: string[];
	manualRemediationPasses: number;
	manuallyTargetedDiscrepancyIds: string[];
	acceptedRemainingDiscrepancies: boolean;
}

function trimBlock(text: string): string {
	return text.trim() ? `${text.trim()}\n` : "";
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

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function collectWorkerAgentFiles(baseAgentFiles: string[], cwd: string, touchedPaths: string[]): string[] {
	return uniquePaths([
		...baseAgentFiles,
		...discoverRelevantGuidance(cwd, touchedPaths, "AGENTS.md").documents.map((document) => document.path),
	]);
}

async function synthesizeImplementationPlan(options: {
	cwd: string;
	tempDir: string;
	agentFiles: string[];
	plannerPrompt: string;
	rawPrompt: string;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
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
	const result = await runSubagent({
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

async function materializeWorkflowPlan(options: {
	cwd: string;
	tempDir: string;
	agentFiles: string[];
	planPath?: string;
	rawPrompt?: string;
	plannerPrompt: string;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
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
			}),
			label: "the synthesized lightweight plan",
		};
	}
	if (!options.planPath) throw new Error("Sub-agent implementation requires either planPath or rawPrompt.");
	const planText = await readFile(resolve(options.planPath), "utf8");
	const workflowPlanPath = join(options.tempDir, "PLAN.md");
	await writeFile(workflowPlanPath, planText, "utf8");
	return { planPath: workflowPlanPath, label: options.planPath };
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

function summarizeAgentsCheckCommands(commands: AgentsCheckCommand[], maxItems = 5): string[] {
	return commands.slice(0, maxItems).map((command) => `${command.command} (${command.source})`);
}

async function requestAgentsCheckExecutionPolicy(
	ctx: ExtensionContext,
	commands: AgentsCheckCommand[],
): Promise<AgentsCheckExecutionPolicy> {
	if (commands.length === 0) return { allowed: true };
	if (!ctx.hasUI) {
		return {
			allowed: false,
			reason: "Explicit approval is required before AGENTS.md commands can run in non-interactive mode.",
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

function createValidationResolutionSummary(): ValidationResolutionSummary {
	return {
		autoRemediationPasses: 0,
		autoRemediatedDiscrepancyIds: [],
		manualRemediationPasses: 0,
		manuallyTargetedDiscrepancyIds: [],
		acceptedRemainingDiscrepancies: false,
	};
}

export function discrepancyAttemptSignature(discrepancy: ValidationDiscrepancy): string {
	const normalize = (value: string): string =>
		value
			.trim()
			.toLowerCase()
			.replace(/["']/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	const idPart = normalize(discrepancy.id || "");
	const itemPart = normalize(discrepancy.item);
	return [idPart, itemPart].filter(Boolean).join("|") || `discrepancy|${discrepancy.status}`;
}

function isActionableDiscrepancy(discrepancy: ValidationDiscrepancy): boolean {
	return discrepancy.status === "missing" || discrepancy.status === "partial";
}

export function partitionValidationDiscrepancies(options: {
	discrepancies: ValidationDiscrepancy[];
	attemptedAutoSignatures?: Iterable<string>;
}): ValidationDiscrepancyTriage {
	const actionableDiscrepancies: ValidationDiscrepancy[] = [];
	const informationalDiscrepancies: ValidationDiscrepancy[] = [];
	const autoDiscrepancies: ValidationDiscrepancy[] = [];
	const remainingActionableDiscrepancies: ValidationDiscrepancy[] = [];
	const attemptedAutoDiscrepancies: ValidationDiscrepancy[] = [];
	const attemptedSignatures = new Set(
		Array.from(options.attemptedAutoSignatures ?? []).map((signature) => signature.trim()).filter(Boolean),
	);

	for (const discrepancy of options.discrepancies) {
		if (!isActionableDiscrepancy(discrepancy)) {
			informationalDiscrepancies.push(discrepancy);
			continue;
		}
		actionableDiscrepancies.push(discrepancy);
		if (discrepancy.worthImplementingNow && !attemptedSignatures.has(discrepancyAttemptSignature(discrepancy))) {
			autoDiscrepancies.push(discrepancy);
			continue;
		}
		remainingActionableDiscrepancies.push(discrepancy);
		if (discrepancy.worthImplementingNow) attemptedAutoDiscrepancies.push(discrepancy);
	}

	return {
		actionableDiscrepancies,
		informationalDiscrepancies,
		autoDiscrepancies,
		remainingActionableDiscrepancies,
		attemptedAutoDiscrepancies,
	};
}

export function renderUnresolvedDiscrepancySummary(discrepancies: ValidationDiscrepancy[]): string {
	const triage = partitionValidationDiscrepancies({ discrepancies });
	if (discrepancies.length === 0) {
		return trimBlock(["## Remaining validator discrepancies", "", "No unresolved discrepancies."].join("\n"));
	}
	return trimBlock(
		[
			"## Remaining validator discrepancies",
			"",
			`Actionable: ${triage.actionableDiscrepancies.length}`,
			`Informational (superseded): ${triage.informationalDiscrepancies.length}`,
			"",
			renderDiscrepancySection(
				"Actionable discrepancies",
				triage.actionableDiscrepancies,
				"No actionable discrepancies remain.",
			),
			"",
			renderDiscrepancySection(
				"Informational discrepancies",
				triage.informationalDiscrepancies,
				"No informational discrepancies remain.",
			),
		].join("\n"),
	);
}

export function renderTargetedDiscrepancyContext(options: {
	selectedDiscrepancies: ValidationDiscrepancy[];
	allDiscrepancies: ValidationDiscrepancy[];
	summary?: string;
	recommendation?: ValidationReport["recommendation"];
}): string {
	const selectedSignatures = new Set(options.selectedDiscrepancies.map((discrepancy) => discrepancyAttemptSignature(discrepancy)));
	const outOfScopeDiscrepancies = options.allDiscrepancies.filter(
		(discrepancy) => !selectedSignatures.has(discrepancyAttemptSignature(discrepancy)),
	);
	return trimBlock(
		[
			"## Targeted validator discrepancy remediation",
			"",
			"Implement only the selected discrepancies in this pass.",
			"Do not implement any other unresolved validator discrepancies unless they are a direct dependency of a selected fix.",
			"Stay within PLAN.md and avoid extra scope.",
			...(options.summary ? ["", `Validator summary: ${options.summary}`] : []),
			...(options.recommendation ? ["", `Validator recommendation: ${options.recommendation}`] : []),
			"",
			renderDiscrepancySection(
				"Selected discrepancies to implement now",
				options.selectedDiscrepancies,
				"No discrepancies were selected for this pass.",
			),
			"",
			renderDiscrepancySection(
				"Other unresolved discrepancies not in scope for this pass",
				outOfScopeDiscrepancies,
				"No other unresolved discrepancies remain.",
			),
		].join("\n"),
	);
}

function buildSummary(
	changedFiles: string[],
	checks: CheckRunSummary[],
	validation: ValidationReport,
	checker: CheckerReport,
	quality: WorkflowQualitySummary,
	validationResolution: ValidationResolutionSummary,
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
				`Legacy code/files removed (verified): ${quality.legacyCodeOrFilesRemoved ? "yes" : "no"}`,
				`Checker findings: ${checker.findings.length}`,
				`Checks run: ${passedChecks} passed, ${failedChecks} flagged findings, ${blockedChecks} blocked, ${erroredChecks} errored`,
				`Validator recommendation: ${validation.recommendation}`,
				`Validator auto-remediation passes: ${validationResolution.autoRemediationPasses}`,
				`Auto-targeted validator discrepancies: ${validationResolution.autoRemediatedDiscrepancyIds.length}`,
				`Validator manual remediation passes: ${validationResolution.manualRemediationPasses}`,
				`Manually targeted validator discrepancies: ${validationResolution.manuallyTargetedDiscrepancyIds.length}`,
				`Remaining discrepancies accepted: ${validationResolution.acceptedRemainingDiscrepancies ? "yes" : "no"}`,
				validation.summary || "",
			].join("\n"),
			renderUnresolvedDiscrepancySummary(validation.discrepancies),
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

export function decideValidatorDiscrepancyHandling(options: {
	validation: ValidationReport;
	hasUI: boolean;
	discrepanciesAccepted?: boolean;
	attemptedAutoSignatures?: Iterable<string>;
	stage: "initial" | "post-remediation";
}): ValidatorDiscrepancyHandlingDecision {
	const triage = partitionValidationDiscrepancies({
		discrepancies: options.validation.discrepancies,
		attemptedAutoSignatures: options.attemptedAutoSignatures,
	});
	if (triage.actionableDiscrepancies.length === 0 || options.discrepanciesAccepted) {
		return { action: "continue", ...triage };
	}
	if (triage.autoDiscrepancies.length > 0) {
		return { action: "auto-remediate", ...triage };
	}
	if (options.hasUI) return { action: "prompt", ...triage };
	const stageNote = options.stage === "post-remediation" ? "after targeted remediation" : "before completion";
	const discrepancies = summarizeDiscrepancies(triage.remainingActionableDiscrepancies);
	return {
		action: "fail",
		message: [
			`Validator still reports actionable plan discrepancies ${stageNote} in non-interactive mode, and no interactive selection path is available.`,
			triage.attemptedAutoDiscrepancies.length > 0
				? `Automatic remediation was already attempted for ${triage.attemptedAutoDiscrepancies.length} worthwhile item(s).`
				: "",
			`Recommendation: ${options.validation.recommendation}`,
			options.validation.summary || `${triage.remainingActionableDiscrepancies.length} actionable discrepancy(s) reported.`,
			...(discrepancies.length > 0 ? [`Remaining actionable discrepancies: ${discrepancies.join(" • ")}`] : []),
		].filter(Boolean).join(" "),
		...triage,
	};
}

type ValidatorDiscrepancyChoice =
	| "Select items to implement now"
	| "Reformulate in discovery mode"
	| "Accept the discrepancies and finish";

async function promptForValidatorDiscrepancyChoice(
	ctx: ExtensionContext,
	validation: ValidationReport,
	options: { heading: string; attemptedAutoSignatures?: Iterable<string> },
): Promise<ValidatorDiscrepancyChoice> {
	const triage = partitionValidationDiscrepancies({
		discrepancies: validation.discrepancies,
		attemptedAutoSignatures: options.attemptedAutoSignatures,
	});
	const discrepancySummary = triage.remainingActionableDiscrepancies
		.slice(0, 5)
		.map((item) => `- ${item.id ? `${item.id} — ` : ""}${item.status}: ${item.item}`)
		.join("\n");
	return (await ctx.ui.select(
		[
			options.heading,
			validation.summary,
			triage.attemptedAutoDiscrepancies.length > 0
				? `${triage.attemptedAutoDiscrepancies.length} worthwhile item(s) were already attempted automatically and still remain.`
				: "",
			discrepancySummary,
		].filter(Boolean).join("\n\n"),
		[
			"Select items to implement now",
			"Reformulate in discovery mode",
			"Accept the discrepancies and finish",
		],
	)) as ValidatorDiscrepancyChoice;
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

export function decideQualitySuiteRound(options: {
	round: number;
	maxRounds: number;
	cleanupReport: CheckerReport;
	designRequired: boolean;
	designReport?: CheckerReport | null;
	checkerReport: CheckerReport;
}): QualitySuiteRoundDecision {
	const findingCounts: Record<QualityStageId, number> = {
		cleanup: options.cleanupReport.findings.length,
		design: options.designRequired ? (options.designReport?.findings.length ?? 0) : 0,
		checker: options.checkerReport.findings.length,
	};
	const triggerStages: QualityStageId[] = [];
	if (findingCounts.cleanup > 0) triggerStages.push("cleanup");
	if (options.designRequired && findingCounts.design > 0) triggerStages.push("design");
	if (findingCounts.checker > 0) triggerStages.push("checker");

	const designReviewStatus = options.designRequired ? "ran" : "skipped";
	if (triggerStages.length === 0) {
		return {
			action: "pass",
			designReviewStatus,
			triggerStages,
			findingCounts,
		};
	}

	if (options.round >= options.maxRounds) {
		const remaining = triggerStages.map((stage) => `${stage} ${findingCounts[stage]}`).join(", ");
		const hardGateNote = triggerStages.includes("design")
			? " Design review is a hard gate and still has outstanding findings."
			: "";
		return {
			action: "fail",
			designReviewStatus,
			triggerStages,
			findingCounts,
			message: `Quality suite exhausted ${options.maxRounds} round(s). Remaining findings: ${remaining}.${hardGateNote}`,
		};
	}

	return {
		action: "remediate",
		designReviewStatus,
		triggerStages,
		findingCounts,
		restartStage: "cleanup",
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
		pendingLegacyCleanupFindingSignatures: new Set<string>(),
		legacyCodeOrFilesRemoved: false,
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
	target.legacyCodeOrFilesRemoved ||= incoming.legacyCodeOrFilesRemoved;
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
		legacyCodeOrFilesRemoved: stats.legacyCodeOrFilesRemoved,
	};
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

	const phaseAgentFiles = collectWorkerAgentFiles(options.agentFiles, options.cwd, options.phase.touchedPaths);
	const result = await runSubagent({
		cwd: options.cwd,
		systemPrompt: promptSelection.systemPrompt,
		prompt: "Implement the assigned phase now. Read the attached plan and phase brief, inspect the relevant files, make the code changes, and then summarize what you completed.",
		files: [options.planPath, ...phaseAgentFiles, phaseContextPath],
		tools: WORKER_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
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
	const result = await runSubagent({
		cwd: options.cwd,
		systemPrompt: options.systemPrompt,
		prompt: options.prompt,
		files: [options.planPath, ...options.agentFiles, contextPath],
		tools: WORKER_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
	});
	return ensureSuccessfulSubagent(options.contextTitle, result);
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
	results.push(
		...agentsCheckRuns.map((run) => ({
			command: run.command,
			source: run.source,
			status: run.status,
			summary: run.summary,
		})),
	);
	const report = appendAgentsChecksToCheckerReport(combineCheckerReports(modelRuns), agentsCheckRuns);
	return { report, guidance: context.guidance, results, modelRuns };
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
	const guidance = discoverRelevantGuidance(options.cwd, options.changedFiles, "AGENTS.md");
	const decompositionPath = await writeTempContextFile(options.tempDir, "validator-decomposition.md", renderDecompositionSummary(options.decomposition));
	const workerSummaryPath = await writeTempContextFile(options.tempDir, "validator-worker-summaries.md", renderWorkerPhaseSummaries(options.workerResults));
	const changedFilesPath = await writeTempContextFile(options.tempDir, "validator-changed-files.md", renderChangedFilesSummary(options.changedFiles));
	const checkerPath = await writeTempContextFile(options.tempDir, "validator-checker.md", renderCheckerFindingsSummary(options.checkerReport));
	const checkResultsPath = await writeTempContextFile(options.tempDir, "validator-check-results.md", renderCheckResultsSummary(options.checkResults));
	const guidancePath = await writeTempContextFile(options.tempDir, "validator-agents-guidance.md", renderRelevantGuidanceSummary(guidance));

	return await runStructuredStage({
		name: "validator",
		systemPrompt: options.validatorPrompt,
		prompt: "Compare the approved plan against the current implementation and return JSON only.",
		files: [
			options.planPath,
			...options.agentFiles,
			...guidance.documents.map((document) => document.path),
			decompositionPath,
			workerSummaryPath,
			changedFilesPath,
			checkerPath,
			checkResultsPath,
			guidancePath,
		],
		tools: READ_ONLY_SUBAGENT_TOOLS,
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tempDir: options.tempDir,
		parse: parseValidationReport,
	});
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
	designContextText?: string;
	resolveAgentsCheckExecutionPolicy?: (commands: AgentsCheckCommand[]) => Promise<AgentsCheckExecutionPolicy>;
}): Promise<QualitySuiteResult> {
	let currentChangedFiles = [...options.changedFiles];
	let designSignalFindings: CheckerReport["findings"] = [];
	const stats = createWorkflowQualityStats();
	let cleanupRun!: SpecialistReviewRun;
	let designRun: SpecialistReviewRun | null = null;
	let checkerRun!: CheckerSuiteResult;

	for (let round = 1; round <= QUALITY_SUITE_MAX_ROUNDS; round++) {
		const roundLabel = `Quality round ${round}/${QUALITY_SUITE_MAX_ROUNDS}`;
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
					qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
					qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
					qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
			cleanupReport: cleanupRun.report,
			designRequired,
			designReport: designRun?.report ?? null,
			checkerReport: checkerRun.report,
		});
		if (decision.action === "pass") {
			return {
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
					qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
				workerKind: remediationPromptSelection.kind,
				note: remediationPromptSelection.reason,
			},
		});
		const fixAgentFiles = [
			...new Set([
				...options.agentFiles,
				...discoverRelevantGuidance(options.cwd, currentChangedFiles, "AGENTS.md").documents.map((document) => document.path),
			]),
		];
		const fixSummary = await runWorkerFixPass({
			cwd: options.cwd,
			tempDir: options.tempDir,
			planPath: options.planPath,
			agentFiles: fixAgentFiles,
			systemPrompt: remediationPromptSelection.systemPrompt,
			contextTitle: `${options.suiteId}-quality-fix-round-${round}`,
			contextMarkdown: renderQualitySuiteRemediationContext({
				round,
				maxRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
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
				qualityRounds: QUALITY_SUITE_MAX_ROUNDS,
				note: `${roundLabel} restarting quality suite from cleanup`,
			},
		);
	}

	throw new Error(`Quality suite exhausted ${QUALITY_SUITE_MAX_ROUNDS} round(s).`);
}

export async function runGuidedDiscoveryImplementationWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: WorkflowOptions,
): Promise<WorkflowSummary> {
	const originalRepoRoot = findRepoRoot(ctx.cwd);
	const exec = makeExec(pi);
	const { workspace: runWorkspace } = await createManagedWorkspace({
		exec,
		sourceCwd: ctx.cwd,
		label: "run",
	});
	const workspaceRepoRoot = findRepoRoot(runWorkspace.cwd);
	const workspaceRelativeCwd = relative(originalRepoRoot, ctx.cwd);
	const workflowCwd = resolve(runWorkspace.cwd, workspaceRelativeCwd);
	let tempDir = "";
	const workflowModels = resolveWorkflowModels(ctx);
	const primaryModel = workflowModels.primary;
	const checkerModels = workflowModels.checkers;
	const thinkingLevel = pi.getThinkingLevel();

	const reviewModels = checkerModels.length > 0 ? checkerModels : primaryModel ? [primaryModel] : [];
	let activeNode: WorkflowNodeId | undefined;
	let runWorkspaceIntegrated = false;
	let agentsCheckExecutionPolicy: AgentsCheckExecutionPolicy | undefined;

	emitWorkflowUpdate(options.onUpdate, {
		type: "workflow-start",
		stage: "starting",
		lines: [
			options.rawPrompt?.trim()
				? "Synthesizing a lightweight plan in an isolated workspace."
				: `Using ${options.planPath} as the approved source of truth in an isolated workspace.`,
			`Workspace: ${runWorkspace.kind} @ ${runWorkspace.cwd}`,
			`Primary model: ${primaryModel ?? "default"}`,
			`Checker models: ${reviewModels.length > 0 ? reviewModels.join(", ") : primaryModel ?? "default"}`,
		],
		context: {
			checkerModels: reviewModels,
			note: "Sub-agent implementation workflow starting",
		},
	});

	try {
		const originalCheckoutBaseline = await createWorkspaceSnapshot({
			cwd: originalRepoRoot,
			touchedPaths: [],
			seededChangedFiles: [],
			includeAllFiles: true,
		});
		tempDir = await mkdtemp(join(runWorkspace.cleanupRoot, "context-"));
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
		const materializedPlan = await materializeWorkflowPlan({
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
		const resolveAgentsCheckExecutionPolicy = async (
			commands: AgentsCheckCommand[],
		): Promise<AgentsCheckExecutionPolicy> => {
			if (agentsCheckExecutionPolicy?.allowed) return agentsCheckExecutionPolicy;
			if (agentsCheckExecutionPolicy && !agentsCheckExecutionPolicy.allowed) return agentsCheckExecutionPolicy;
			agentsCheckExecutionPolicy = await requestAgentsCheckExecutionPolicy(ctx, commands);
			return agentsCheckExecutionPolicy;
		};
		const integrateRunWorkspace = async (): Promise<void> => {
			if (runWorkspaceIntegrated) return;
			const finalIntegration = await planWorkspaceIntegration({
				childCwd: runWorkspace.cwd,
				parentCwd: originalRepoRoot,
				baseline: originalCheckoutBaseline,
				exec,
			});
			if (finalIntegration.conflictingFiles.length > 0) {
				throw new Error(
					`The original checkout changed while the isolated workspace was running. Resolve these files manually and rerun: ${finalIntegration.conflictingFiles.join(", ")}`,
				);
			}
			await syncWorkspaceFiles({
				sourceCwd: runWorkspace.cwd,
				targetCwd: originalRepoRoot,
				files: finalIntegration.nonConflictingFiles,
			});
			runWorkspaceIntegrated = true;
		};
		const planInfoPath = await writeTempContextFile(
			tempDir,
			"workflow-instructions.md",
			[
				"## Workflow instructions",
				"",
				`- original repo root: ${originalRepoRoot}`,
				`- isolated workspace root: ${workspaceRepoRoot}`,
				`- workflow cwd: ${workflowCwd}`,
				`- approved plan source: ${materializedPlan.label}`,
				...(options.extraInstructions.trim()
					? ["", "## Additional instructions", "", options.extraInstructions.trim()]
					: []),
			].join("\n"),
		);

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

		const workerResults: WorkerPhaseResult[] = [];
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
			const runBatchPhase = (phase: DecompositionPhase, cwd: string): Promise<WorkerPhaseResult> =>
				runWorkerPhase({
					cwd,
					tempDir,
					planPath,
					agentFiles,
					workerPrompt,
					designWorkerPrompt,
					phase,
					batchIndex,
					batchCount: batches.length,
					extraInstructions: options.extraInstructions,
					model: primaryModel,
					thinkingLevel,
					onUpdate: options.onUpdate,
				});
			const phaseResults: WorkerPhaseResult[] = [];
			if (batch.length > 1) {
				const childRuns = await Promise.all(
					batch.map(async (phase) => {
						const child = await createChildWorkspace({
							exec,
							parentCwd: runWorkspace.cwd,
							label: phase.id,
							touchedPaths: phase.touchedPaths,
						});
						const childWorkflowCwd = resolve(child.workspace.cwd, workspaceRelativeCwd);
						try {
							return {
								phase,
								child,
								result: await runBatchPhase(phase, childWorkflowCwd),
							};
						} catch (error) {
							await child.workspace.cleanup();
							throw error;
						}
					}),
				);
				for (const childRun of childRuns) {
					const integration = await planWorkspaceIntegration({
						childCwd: childRun.child.workspace.cwd,
						parentCwd: runWorkspace.cwd,
						baseline: childRun.child.baseline,
						exec,
					});
					await syncWorkspaceFiles({
						sourceCwd: childRun.child.workspace.cwd,
						targetCwd: runWorkspace.cwd,
						files: integration.nonConflictingFiles,
					});
					if (integration.conflictingFiles.length > 0) {
						const summary = await resolveWorkspaceIntegrationConflicts({
							cwd: workflowCwd,
							tempDir,
							planPath,
							agentFiles: collectWorkerAgentFiles(agentFiles, workflowCwd, integration.conflictingFiles),
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
					phaseResults.push(childRun.result);
					await childRun.child.workspace.cleanup();
				}
			} else {
				phaseResults.push(await runBatchPhase(batch[0], workflowCwd));
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
		const workflowQualityStats = createWorkflowQualityStats();
		const setActiveNode = (nodeId: WorkflowNodeId): void => {
			activeNode = nodeId;
		};

		let qualityPass = await runQualitySuite({
			cwd: workflowCwd,
			tempDir,
			planPath,
			agentFiles,
			workerPrompt,
			designWorkerPrompt,
			cleanupPrompt,
			designReviewPrompt: designReviewPrompt,
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
			suiteId: "implementation",
			resolveAgentsCheckExecutionPolicy,
		});
		mergeWorkflowQualityStats(workflowQualityStats, qualityPass.stats);
		changedFiles = qualityPass.changedFiles;
		let checkPass = qualityPass.checkerRun;

		const validationResolution = createValidationResolutionSummary();
		const autoAttemptedDiscrepancySignatures = new Set<string>();
		let validation!: ValidationReport;
		let discrepancySummaryItems: string[] = [];
		const recordDiscrepancyIds = (target: string[], discrepancies: ValidationDiscrepancy[]): void => {
			for (const discrepancy of discrepancies) {
				const id = discrepancy.id || discrepancy.item;
				if (id && !target.includes(id)) target.push(id);
			}
		};
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
		const runTargetedValidatorRemediation = async (remediation: {
			kind: "auto" | "manual";
			discrepancies: ValidationDiscrepancy[];
			suiteId: string;
			title: string;
			goal: string;
			instruction: string;
			loopNote: string;
			completionNote: string;
		}): Promise<void> => {
			const targetedSummaryItems = summarizeDiscrepancies(remediation.discrepancies);
			const remediationScopeLabel = remediation.kind === "auto" ? "targeted" : "selected";
			const finishContextText = renderTargetedDiscrepancyContext({
				selectedDiscrepancies: remediation.discrepancies,
				allDiscrepancies: validation.discrepancies,
				summary: validation.summary,
				recommendation: validation.recommendation,
			});
			const finishPromptSelection = pickRemediationPrompt({
				workerPrompt,
				designWorkerPrompt,
				phases: workerResults.map((result) => result.phase),
				changedFiles,
				discrepancyText: finishContextText,
			});
			emitLoopTraversal(
				options.onUpdate,
				"validator->finish",
				"finish",
				[
					`${remediation.kind === "auto" ? "Automatically remediating" : "Implementing"} ${remediation.discrepancies.length} ${remediationScopeLabel} validator discrepancy(s).`,
					...(targetedSummaryItems.length > 0 ? [`Discrepancies: ${targetedSummaryItems.join(" • ")}`] : []),
					`Worker: ${finishPromptSelection.promptLabel}`,
				],
				{
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					discrepancyCount: remediation.discrepancies.length,
					discrepancySummary: targetedSummaryItems,
					recommendation: validation.recommendation,
					workerKind: finishPromptSelection.kind,
					note: remediation.loopNote,
				},
			);
			activeNode = "finish";
			emitWorkflowUpdate(options.onUpdate, {
				type: "finish-started",
				stage: "finish",
				lines: [
					`${remediation.kind === "auto" ? "Automatically remediating" : "Implementing"} ${remediation.discrepancies.length} ${remediationScopeLabel} validator discrepancy(s).`,
					`Changed files: ${summarizePaths(changedFiles)}`,
					`Worker: ${finishPromptSelection.promptLabel}`,
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					discrepancyCount: remediation.discrepancies.length,
					discrepancySummary: targetedSummaryItems,
					recommendation: validation.recommendation,
					workerKind: finishPromptSelection.kind,
					note: finishPromptSelection.reason,
				},
			});
			const finishAgentFiles = [
				...new Set([
					...agentFiles,
					...discoverRelevantGuidance(workflowCwd, changedFiles, "AGENTS.md").documents.map((document) => document.path),
				]),
			];
			const finishSummary = await runWorkerFixPass({
				cwd: workflowCwd,
				tempDir,
				planPath,
				agentFiles: finishAgentFiles,
				systemPrompt: finishPromptSelection.systemPrompt,
				contextTitle: `${remediation.suiteId}-validator-pass`,
				contextMarkdown: finishContextText,
				prompt:
					"Implement only the selected validator discrepancies in the attached context. Do not implement other unresolved validator discrepancies unless they are a direct dependency of a selected fix. Stay within PLAN.md, avoid extra scope, and then summarize what you finished.",
				model: primaryModel,
				thinkingLevel,
			});
			workerResults.push({
				phase: {
					id: `${remediation.suiteId}-validator-pass`,
					title: remediation.title,
					goal: remediation.goal,
					instructions: [remediation.instruction],
					dependsOn: [],
					touchedPaths: changedFiles,
					parallelSafe: false,
					designSensitive: finishPromptSelection.designSensitive,
				},
				summary: finishSummary,
			});
			if (remediation.kind === "auto") {
				validationResolution.autoRemediationPasses += 1;
				recordDiscrepancyIds(validationResolution.autoRemediatedDiscrepancyIds, remediation.discrepancies);
			} else {
				validationResolution.manualRemediationPasses += 1;
				recordDiscrepancyIds(validationResolution.manuallyTargetedDiscrepancyIds, remediation.discrepancies);
			}
			emitWorkflowUpdate(options.onUpdate, {
				type: "finish-completed",
				stage: "finish",
				lines: [
					`${remediation.kind === "auto" ? "Completed automatic" : "Completed selected"} validator remediation pass.`,
					`Changed files: ${summarizePaths(changedFiles)}`,
					`Worker: ${finishPromptSelection.promptLabel}`,
				],
				context: {
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					discrepancyCount: remediation.discrepancies.length,
					discrepancySummary: targetedSummaryItems,
					recommendation: validation.recommendation,
					workerKind: finishPromptSelection.kind,
					note: finishPromptSelection.reason,
				},
			});
			changedFiles = await detectChangedFiles(workflowCwd, exec);
			emitLoopTraversal(
				options.onUpdate,
				"finish->cleanup",
				"cleanup",
				[
					`Re-running cleanup, design review, and checker after ${remediation.kind === "auto" ? "automatic" : "selected-item"} validator remediation.`,
					`Changed files: ${summarizePaths(changedFiles)}`,
				],
				{
					changedFiles,
					changedFilesSummary: summarizePaths(changedFiles),
					discrepancyCount: remediation.discrepancies.length,
					discrepancySummary: targetedSummaryItems,
					recommendation: validation.recommendation,
					note: remediation.completionNote,
				},
			);
			qualityPass = await runQualitySuite({
				cwd: workflowCwd,
				tempDir,
				planPath,
				agentFiles,
				workerPrompt,
				designWorkerPrompt,
				cleanupPrompt,
				designReviewPrompt: designReviewPrompt,
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
				suiteId: remediation.suiteId,
				designContextText: finishContextText,
				resolveAgentsCheckExecutionPolicy,
			});
			mergeWorkflowQualityStats(workflowQualityStats, qualityPass.stats);
			changedFiles = qualityPass.changedFiles;
			checkPass = qualityPass.checkerRun;
		};

		await runValidatorPass({
			startLine: "Comparing the implementation against PLAN.md.",
			startedNote: "Validator started",
			completedNote: "Validator completed",
		});

		let validatorDiscrepanciesAccepted = false;
		const returnReformulation = async (): Promise<WorkflowSummary> => {
			await integrateRunWorkspace();
			const summary = buildSummary(
				changedFiles,
				checkPass.results,
				validation,
				checkPass.report,
				summarizeWorkflowQualityStats(workflowQualityStats),
				validationResolution,
			);
			emitWorkflowUpdate(options.onUpdate, {
				type: "workflow-completed",
				stage: "complete",
				lines: [
					"Implementation paused for discovery reformulation.",
					`Validator recommendation: ${validation.recommendation}`,
				],
				context: {
					discrepancyCount: validation.discrepancies.length,
					discrepancySummary: discrepancySummaryItems,
					recommendation: validation.recommendation,
					note: "Workflow handed back to discovery mode",
				},
			});
			return {
				decision: "reformulate",
				summary,
				reformulationPrompt: buildReformulationPrompt(validation),
			};
		};

		while (true) {
			const validationHandling = decideValidatorDiscrepancyHandling({
				validation,
				hasUI: ctx.hasUI,
				discrepanciesAccepted: validatorDiscrepanciesAccepted,
				attemptedAutoSignatures: autoAttemptedDiscrepancySignatures,
				stage:
					validationResolution.autoRemediationPasses > 0 || validationResolution.manualRemediationPasses > 0
						? "post-remediation"
						: "initial",
			});
			if (validationHandling.action === "continue") break;
			if (validationHandling.action === "fail") {
				throw new Error(validationHandling.message || "Validator reported unresolved actionable discrepancies.");
			}
			if (validationHandling.action === "auto-remediate") {
				for (const discrepancy of validationHandling.autoDiscrepancies) {
					autoAttemptedDiscrepancySignatures.add(discrepancyAttemptSignature(discrepancy));
				}
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "validator",
					lines: [
						`Automatically remediating ${validationHandling.autoDiscrepancies.length} worthwhile validator discrepancy(s).`,
						...(summarizeDiscrepancies(validationHandling.autoDiscrepancies).length > 0
							? [`Discrepancies: ${summarizeDiscrepancies(validationHandling.autoDiscrepancies).join(" • ")}`]
							: []),
					],
					context: {
						discrepancyCount: validationHandling.autoDiscrepancies.length,
						discrepancySummary: summarizeDiscrepancies(validationHandling.autoDiscrepancies),
						recommendation: validation.recommendation,
						note: "Automatically remediating worthwhile discrepancies",
					},
				});
				await runTargetedValidatorRemediation({
					kind: "auto",
					discrepancies: validationHandling.autoDiscrepancies,
					suiteId: `post-auto-${validationResolution.autoRemediationPasses + 1}`,
					title: `Validator auto-remediation pass ${validationResolution.autoRemediationPasses + 1}`,
					goal: "Implement only the worthwhile validator discrepancies selected for automatic remediation",
					instruction: "Implement only the selected worthwhile validator discrepancies.",
					loopNote: "Validator triggered automatic worthwhile-item remediation",
					completionNote: "Returning to cleanup after automatic validator remediation",
				});
				await runValidatorPass({
					startLine: "Re-running validator after targeted validator remediation.",
					startedNote: "Validator restarted after targeted remediation",
					completedNote: "Validator completed after targeted remediation",
				});
				continue;
			}
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "validator",
				lines: [
					`Validator still found ${validationHandling.remainingActionableDiscrepancies.length} actionable discrepancy(s).`,
					...(validationHandling.attemptedAutoDiscrepancies.length > 0
						? [`Already auto-attempted: ${summarizeDiscrepancies(validationHandling.attemptedAutoDiscrepancies).join(" • ")}`]
						: []),
					`Recommendation: ${validation.recommendation}`,
					...(summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies).length > 0
						? [`Remaining actionable discrepancies: ${summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies).join(" • ")}`]
						: []),
				],
				context: {
					discrepancyCount: validationHandling.remainingActionableDiscrepancies.length,
					discrepancySummary: summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies),
					recommendation: validation.recommendation,
					note: "Awaiting validator discrepancy decision",
				},
			});
			const choice = await promptForValidatorDiscrepancyChoice(ctx, validation, {
				attemptedAutoSignatures: autoAttemptedDiscrepancySignatures,
				heading:
					validationResolution.autoRemediationPasses > 0 || validationResolution.manualRemediationPasses > 0
						? "Validator still found unresolved plan discrepancies after targeted remediation. What next?"
						: "Validator found unresolved plan discrepancies. What next?",
			});
			if (choice === "Reformulate in discovery mode") return await returnReformulation();
			if (choice === "Accept the discrepancies and finish") {
				validatorDiscrepanciesAccepted = true;
				validationResolution.acceptedRemainingDiscrepancies = true;
				break;
			}
			emitWorkflowUpdate(options.onUpdate, {
				type: "detail-lines",
				stage: "validator",
				lines: [
					`Waiting for selection of ${validationHandling.remainingActionableDiscrepancies.length} actionable validator discrepancy(s).`,
					"Select only the items you want to implement in this pass.",
					...(validationHandling.informationalDiscrepancies.length > 0
						? [`Informational only: ${validationHandling.informationalDiscrepancies.length} superseded discrepancy(s).`]
						: []),
				],
				context: {
					discrepancyCount: validationHandling.remainingActionableDiscrepancies.length,
					discrepancySummary: summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies),
					recommendation: validation.recommendation,
					note: "Waiting for validator discrepancy selection",
				},
			});
			const selectedManualDiscrepancies = await selectRemainingActionableDiscrepancies(ctx, {
				title: "Select validator discrepancies to implement",
				actionableDiscrepancies: validationHandling.remainingActionableDiscrepancies,
				informationalDiscrepancies: validationHandling.informationalDiscrepancies,
				introLines: [
					validation.summary || `${validationHandling.remainingActionableDiscrepancies.length} actionable discrepancy(s) remain.`,
					...(validationHandling.attemptedAutoDiscrepancies.length > 0
						? [
							`${validationHandling.attemptedAutoDiscrepancies.length} worthwhile item(s) were already auto-attempted and still remain unresolved.`,
						]
						: []),
				],
			});
			if (selectedManualDiscrepancies === undefined) {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "validator",
					lines: [
						"Validator discrepancy selection was cancelled.",
						"Choose whether to select items, reformulate, or accept the remaining discrepancies.",
					],
					context: {
						discrepancyCount: validationHandling.remainingActionableDiscrepancies.length,
						discrepancySummary: summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies),
						recommendation: validation.recommendation,
						note: "Validator discrepancy selection cancelled",
					},
				});
				continue;
			}
			if (selectedManualDiscrepancies.length === 0) {
				emitWorkflowUpdate(options.onUpdate, {
					type: "detail-lines",
					stage: "validator",
					lines: [
						"No validator discrepancies were selected for manual remediation.",
						"Choose whether to select items, reformulate, or accept the remaining discrepancies.",
					],
					context: {
						discrepancyCount: validationHandling.remainingActionableDiscrepancies.length,
						discrepancySummary: summarizeDiscrepancies(validationHandling.remainingActionableDiscrepancies),
						recommendation: validation.recommendation,
						note: "No validator discrepancies selected",
					},
				});
				continue;
			}
			await runTargetedValidatorRemediation({
				kind: "manual",
				discrepancies: selectedManualDiscrepancies,
				suiteId: `post-manual-${validationResolution.manualRemediationPasses + 1}`,
				title: `Validator selected-item remediation pass ${validationResolution.manualRemediationPasses + 1}`,
				goal: "Implement only the selected actionable validator discrepancies",
				instruction: "Implement only the selected validator discrepancies.",
				loopNote: "Validator requested selected-item remediation",
				completionNote: "Returning to cleanup after selected validator remediation",
			});
			await runValidatorPass({
				startLine: "Re-running validator after selected validator remediation.",
				startedNote: "Validator restarted after selected-item remediation",
				completedNote: "Validator completed after selected-item remediation",
			});
		}

		await integrateRunWorkspace();
		const summary = buildSummary(
			changedFiles,
			checkPass.results,
			validation,
			checkPass.report,
			summarizeWorkflowQualityStats(workflowQualityStats),
			validationResolution,
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
		return {
			decision: "done",
			summary,
		};
	} catch (error) {
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
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		await runWorkspace.cleanup();
	}
}
