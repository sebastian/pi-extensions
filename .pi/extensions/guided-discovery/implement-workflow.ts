import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeExecutionBatches, detectChangedFiles, type ExecLike } from "./changes.ts";
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
	hasMaterialDiscrepancies,
	parseCheckerReport,
	parseDecompositionPlan,
	parseValidationReport,
	type CheckerReport,
	type DecompositionPhase,
	type DecompositionPlan,
	type ValidationReport,
} from "./structured-output.ts";

const READ_ONLY_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];
const WORKER_SUBAGENT_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];

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

type WorkflowDecision = "done" | "reformulate";

interface WorkflowStageUpdate {
	stage: string;
	lines: string[];
}

interface WorkflowOptions {
	planPath: string;
	extraInstructions: string;
	onUpdate?: (update: WorkflowStageUpdate) => void;
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
		lines.push(`### ${result.phase.id}: ${result.phase.title}`, "", result.summary || "(no summary)", "");
	}
	return trimBlock(lines.join("\n"));
}

function renderRelevantGuidanceSummary(result: RelevantGuidanceResult): string {
	return renderGuidanceSummary(result, "AGENTS.md");
}

function renderCheckResultsSummary(results: CheckRunSummary[]): string {
	const lines = ["## Checker model reviews", ""];
	if (results.length === 0) {
		lines.push("No checker reviews were recorded.");
	} else {
		for (const result of results) {
			lines.push(`- ${result.command} (${result.source}) => ${result.status}: ${result.summary}`);
		}
	}
	return trimBlock(lines.join("\n"));
}

function renderCheckerFindingsSummary(report: CheckerReport): string {
	const lines = ["## Checker findings", ""];
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

function renderValidationSummary(report: ValidationReport): string {
	const lines = ["## Validator summary", "", report.summary || "(no summary)", "", "## Coverage", ""];
	for (const item of report.coverage) {
		lines.push(`- ${item.status}: ${item.item}${item.evidence ? ` — ${item.evidence}` : ""}`);
	}
	if (report.discrepancies.length > 0) {
		lines.push("", "## Discrepancies", "");
		for (const discrepancy of report.discrepancies) {
			lines.push(`- ${discrepancy.status}: ${discrepancy.item}`);
			if (discrepancy.reason) lines.push(`  - reason: ${discrepancy.reason}`);
			if (discrepancy.suggestedAction) lines.push(`  - suggested action: ${discrepancy.suggestedAction}`);
		}
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

function buildSummary(
	changedFiles: string[],
	checks: CheckRunSummary[],
	validation: ValidationReport,
	checker: CheckerReport,
): string {
	const passedChecks = checks.filter((check) => check.status === "passed").length;
	const failedChecks = checks.filter((check) => check.status === "failed").length;
	const blockedChecks = checks.filter((check) => check.status === "blocked").length;
	const erroredChecks = checks.filter((check) => check.status === "error").length;
	return trimBlock(
		[
			"Sub-agent implementation workflow finished.",
			changedFiles.length > 0 ? `Changed files (${changedFiles.length}): ${changedFiles.join(", ")}` : "Changed files: none detected",
			`Checker findings: ${checker.findings.length}`,
			`Checker reviews: ${passedChecks} passed, ${failedChecks} flagged findings, ${blockedChecks} blocked, ${erroredChecks} errored`,
			`Validator recommendation: ${validation.recommendation}`,
			validation.summary || "",
		].join("\n"),
	);
}

function buildReformulationPrompt(validation: ValidationReport): string {
	const lines = [
		"Please reformulate the approved plan based on the implementation discrepancies below.",
		"Keep the parts that already worked, and update the plan only where the validator found meaningful gaps or superseded decisions.",
		"Use PLAN.md as the source of truth and produce a fresh final plan when ready.",
		"",
		`Validator summary: ${validation.summary || "(no summary provided)"}`,
	];
	if (validation.discrepancies.length > 0) {
		lines.push("", "Discrepancies:");
		for (const discrepancy of validation.discrepancies) {
			lines.push(`- ${discrepancy.status}: ${discrepancy.item}`);
			if (discrepancy.reason) lines.push(`  reason: ${discrepancy.reason}`);
			if (discrepancy.suggestedAction) lines.push(`  suggested action: ${discrepancy.suggestedAction}`);
		}
	}
	return lines.join("\n").trim();
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
	onUpdate?: (update: WorkflowStageUpdate) => void;
}): Promise<T> {
	options.onUpdate?.({
		stage: options.name,
		lines: [`${options.name}: running structured sub-agent`],
	});

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

async function runWorkerPhase(options: {
	cwd: string;
	tempDir: string;
	planPath: string;
	agentFiles: string[];
	systemPrompt: string;
	phase: DecompositionPhase;
	extraInstructions: string;
	model?: string;
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowStageUpdate) => void;
}): Promise<WorkerPhaseResult> {
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
			"",
			"## Instructions",
			"",
			...options.phase.instructions.map((instruction) => `- ${instruction}`),
			...(options.extraInstructions.trim() ? ["", "## Additional instructions", "", options.extraInstructions.trim()] : []),
		].join("\n"),
	);

	options.onUpdate?.({
		stage: `worker:${options.phase.id}`,
		lines: [`Implementing ${options.phase.title}`, `Touched paths: ${options.phase.touchedPaths.join(", ") || "unknown"}`],
	});

	const result = await runSubagent({
		cwd: options.cwd,
		systemPrompt: options.systemPrompt,
		prompt: "Implement the assigned phase now. Read the attached plan and phase brief, inspect the relevant files, make the code changes, and then summarize what you completed.",
		files: [options.planPath, ...options.agentFiles, phaseContextPath],
		tools: WORKER_SUBAGENT_TOOLS,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
	});

	const summary = ensureSuccessfulSubagent(`worker ${options.phase.id}`, result);
	return {
		phase: options.phase,
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
	onUpdate?: (update: WorkflowStageUpdate) => void;
}): Promise<string> {
	const contextPath = await writeTempContextFile(
		options.tempDir,
		`${options.contextTitle.replace(/\W+/g, "-")}.md`,
		options.contextMarkdown,
	);
	options.onUpdate?.({
		stage: options.contextTitle,
		lines: [options.prompt],
	});
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
	thinkingLevel?: string;
	onUpdate?: (update: WorkflowStageUpdate) => void;
}): Promise<{ report: CheckerReport; guidance: RelevantGuidanceResult; results: CheckRunSummary[]; modelRuns: CheckerModelRun[] }> {
	const guidance = discoverRelevantGuidance(options.cwd, options.changedFiles, "AGENTS.md");
	const guidancePaths = guidance.documents.map((document) => document.path);
	const decompositionPath = await writeTempContextFile(options.tempDir, "decomposition.md", renderDecompositionSummary(options.decomposition));
	const workerSummaryPath = await writeTempContextFile(options.tempDir, "worker-summaries.md", renderWorkerPhaseSummaries(options.workerResults));
	const changedFilesPath = await writeTempContextFile(options.tempDir, "changed-files.md", renderChangedFilesSummary(options.changedFiles));
	const guidancePath = await writeTempContextFile(options.tempDir, "agents-guidance.md", renderRelevantGuidanceSummary(guidance));
	const files = [
		options.planPath,
		...options.agentFiles,
		...guidancePaths,
		decompositionPath,
		workerSummaryPath,
		changedFilesPath,
		guidancePath,
	];

	const modelRuns: CheckerModelRun[] = [];
	const results: CheckRunSummary[] = [];
	const reviewModels = options.checkerModels.length > 0 ? options.checkerModels : [undefined];
	for (const model of reviewModels) {
		options.onUpdate?.({
			stage: "checks",
			lines: [
				`Running checker model ${model ?? "default"}`,
				`Relevant AGENTS.md files: ${guidance.documents.length}`,
			],
		});
		try {
			const report = await runStructuredStage({
				name: `checker-${model ?? "default"}`,
				systemPrompt: options.checkerPrompt,
				prompt: "Review the implementation, the changed files, the worker summaries, and the relevant AGENTS.md guidance. Return JSON only.",
				files,
				tools: READ_ONLY_SUBAGENT_TOOLS,
				cwd: options.cwd,
				model,
				thinkingLevel: options.thinkingLevel,
				tempDir: options.tempDir,
				parse: parseCheckerReport,
				onUpdate: options.onUpdate,
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

	const report = combineCheckerReports(modelRuns);
	return { report, guidance, results, modelRuns };
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
	onUpdate?: (update: WorkflowStageUpdate) => void;
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
		onUpdate: options.onUpdate,
	});
}

export async function runGuidedDiscoveryImplementationWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: WorkflowOptions,
): Promise<WorkflowSummary> {
	const planPath = resolve(options.planPath);
	const repoRoot = findRepoRoot(ctx.cwd);
	const tempDir = await mkdtemp(join(tmpdir(), "guided-discovery-"));
	const exec = makeExec(pi);
	const workflowModels = resolveWorkflowModels(ctx);
	const primaryModel = workflowModels.primary;
	const checkerModels = workflowModels.checkers;
	const thinkingLevel = pi.getThinkingLevel();

	const update = (stage: string, lines: string[]) => options.onUpdate?.({ stage, lines });

	try {
		const [decomposerPrompt, workerPrompt, checkerPrompt, validatorPrompt] = await Promise.all([
			readBundledPrompt("decomposer"),
			readBundledPrompt("worker"),
			readBundledPrompt("checker"),
			readBundledPrompt("validator"),
		]);
		const agentFiles = await existingFiles(discoverAncestorDocumentPaths(ctx.cwd, repoRoot, "AGENTS.md"));
		const planInfoPath = await writeTempContextFile(
			tempDir,
			"workflow-instructions.md",
			[
				"## Workflow instructions",
				"",
				`- repo root: ${repoRoot}`,
				`- working directory: ${ctx.cwd}`,
				...(options.extraInstructions.trim()
					? ["", "## Additional instructions", "", options.extraInstructions.trim()]
					: []),
			].join("\n"),
		);

		update("decomposer", [
			"Breaking the approved plan into implementation phases...",
			`Primary model: ${primaryModel ?? "default"}`,
			`Checker models: ${checkerModels.length > 0 ? checkerModels.join(", ") : primaryModel ?? "default"}`,
		]);
		const decomposition = await runStructuredStage({
			name: "decomposer",
			systemPrompt: decomposerPrompt,
			prompt: "Break the attached approved PLAN.md into actionable implementation phases for the sub-agent workflow. Return JSON only.",
			files: [planPath, ...agentFiles, planInfoPath],
			tools: READ_ONLY_SUBAGENT_TOOLS,
			cwd: ctx.cwd,
			model: primaryModel,
			thinkingLevel,
			tempDir,
			parse: parseDecompositionPlan,
			onUpdate: options.onUpdate,
		});

		const batches = computeExecutionBatches(decomposition.phases);
		const workerResults: WorkerPhaseResult[] = [];
		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];
			update("worker", [
				`Running implementation batch ${batchIndex + 1}/${batches.length}`,
				batch.map((phase) => `${phase.id}: ${phase.title}`).join(" | "),
			]);
			const phaseResults =
				batch.length > 1
					? await Promise.all(
							batch.map((phase) =>
								runWorkerPhase({
									cwd: ctx.cwd,
									tempDir,
									planPath,
									agentFiles,
									systemPrompt: workerPrompt,
									phase,
									extraInstructions: options.extraInstructions,
									model: primaryModel,
									thinkingLevel,
									onUpdate: options.onUpdate,
								}),
							),
						)
					: [
							await runWorkerPhase({
								cwd: ctx.cwd,
								tempDir,
								planPath,
								agentFiles,
								systemPrompt: workerPrompt,
								phase: batch[0],
								extraInstructions: options.extraInstructions,
								model: primaryModel,
								thinkingLevel,
								onUpdate: options.onUpdate,
							}),
						];
			workerResults.push(...phaseResults);
		}

		let changedFiles = await detectChangedFiles(ctx.cwd, exec);
		let checkPass = await runCheckerSuite({
			cwd: ctx.cwd,
			tempDir,
			planPath,
			agentFiles,
			checkerPrompt,
			decomposition,
			workerResults,
			changedFiles,
			checkerModels: checkerModels.length > 0 ? checkerModels : primaryModel ? [primaryModel] : [],
			thinkingLevel,
			onUpdate: options.onUpdate,
		});

		if (checkPass.report.findings.length > 0) {
			update("fix", [`Applying ${checkPass.report.findings.length} checker finding(s)...`]);
			const fixAgentFiles = [
				...new Set([
					...agentFiles,
					...discoverRelevantGuidance(ctx.cwd, changedFiles, "AGENTS.md").documents.map((document) => document.path),
				]),
			];
			const fixSummary = await runWorkerFixPass({
				cwd: ctx.cwd,
				tempDir,
				planPath,
				agentFiles: fixAgentFiles,
				systemPrompt: workerPrompt,
				contextTitle: "checker-fix-pass",
				contextMarkdown: renderCheckerFindingsSummary(checkPass.report),
				prompt:
					"Apply the attached checker findings now. Fix concrete issues, keep the implementation simple, and then summarize what you changed.",
				model: primaryModel,
				thinkingLevel,
				onUpdate: options.onUpdate,
			});
			workerResults.push({
				phase: {
					id: "checker-fix-pass",
					title: "Checker fix pass",
					goal: "Apply checker findings and clean up loose ends",
					instructions: ["Fix the checker findings produced by the review stage."],
					dependsOn: [],
					touchedPaths: changedFiles,
					parallelSafe: false,
				},
				summary: fixSummary,
			});

			changedFiles = await detectChangedFiles(ctx.cwd, exec);
			checkPass = await runCheckerSuite({
				cwd: ctx.cwd,
				tempDir,
				planPath,
				agentFiles,
				checkerPrompt,
				decomposition,
				workerResults,
				changedFiles,
				checkerModels: checkerModels.length > 0 ? checkerModels : primaryModel ? [primaryModel] : [],
				thinkingLevel,
				onUpdate: options.onUpdate,
			});
		}

		let validation = await runValidator({
			cwd: ctx.cwd,
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
			onUpdate: options.onUpdate,
		});

		if (hasMaterialDiscrepancies(validation) && ctx.hasUI) {
			const discrepancySummary = validation.discrepancies
				.slice(0, 5)
				.map((item) => `- ${item.status}: ${item.item}`)
				.join("\n");
			const choice = await ctx.ui.select(
				[
					"Validator found material plan discrepancies. What next?",
					validation.summary,
					discrepancySummary,
				]
					.filter(Boolean)
					.join("\n\n"),
				[
					"Implement remaining items now",
					"Reformulate in discovery mode",
					"Accept the discrepancies and finish",
				],
			);

			if (choice === "Reformulate in discovery mode") {
				return {
					decision: "reformulate",
					summary: buildSummary(changedFiles, checkPass.results, validation, checkPass.report),
					reformulationPrompt: buildReformulationPrompt(validation),
				};
			}

			if (choice === "Implement remaining items now") {
				const finishAgentFiles = [
					...new Set([
						...agentFiles,
						...discoverRelevantGuidance(ctx.cwd, changedFiles, "AGENTS.md").documents.map((document) => document.path),
					]),
				];
				const finishSummary = await runWorkerFixPass({
					cwd: ctx.cwd,
					tempDir,
					planPath,
					agentFiles: finishAgentFiles,
					systemPrompt: workerPrompt,
					contextTitle: "validator-finish-pass",
					contextMarkdown: renderValidationSummary(validation),
					prompt:
						"Implement the remaining validator discrepancies now. Stay within PLAN.md, avoid extra scope, and then summarize what you finished.",
					model: primaryModel,
					thinkingLevel,
					onUpdate: options.onUpdate,
				});
				workerResults.push({
					phase: {
						id: "validator-finish-pass",
						title: "Validator finish pass",
						goal: "Implement remaining validator discrepancies",
						instructions: ["Implement the remaining validator discrepancies."],
						dependsOn: [],
						touchedPaths: changedFiles,
						parallelSafe: false,
					},
					summary: finishSummary,
				});
				changedFiles = await detectChangedFiles(ctx.cwd, exec);
				checkPass = await runCheckerSuite({
					cwd: ctx.cwd,
					tempDir,
					planPath,
					agentFiles,
					checkerPrompt,
					decomposition,
					workerResults,
					changedFiles,
					checkerModels: checkerModels.length > 0 ? checkerModels : primaryModel ? [primaryModel] : [],
					thinkingLevel,
					onUpdate: options.onUpdate,
				});
				validation = await runValidator({
					cwd: ctx.cwd,
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
					onUpdate: options.onUpdate,
				});
			}
		}

		return {
			decision: "done",
			summary: buildSummary(changedFiles, checkPass.results, validation, checkPass.report),
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}
