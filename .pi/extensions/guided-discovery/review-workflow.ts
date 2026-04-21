import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	detectChangedFiles,
	parseGitDiffNameOnly,
	pathsOverlap,
	type ExecLike,
} from "./changes.ts";
import { discoverRelevantGuidance } from "./guidance.ts";
import { resolveReviewModels } from "./models.ts";
import { detectRepoKind, findRepoLocation, findRepoRootOrSelf } from "./repo.ts";
import { type CheckerFinding, parseCheckerReport } from "./structured-output.ts";
import { runSubagent } from "./subagent-runner.ts";

const REVIEW_STATUS_KEY = "guided-review";
const REVIEW_WIDGET_KEY = "guided-review";
const REVIEW_TOOLS = ["read", "bash", "grep", "find", "ls"];

const REVIEW_SYSTEM_PROMPT = `You are a high-signal code reviewer.

Review the attached change carefully. Focus on:
- logic bugs and correctness issues
- regression risk
- security issues
- unintended side effects in nearby flows
- materially relevant performance risks
- violations of repository guidance or AGENTS.md instructions

Rules:
- Treat this like a strong PR review, not a broad brainstorming pass.
- Only report concrete, actionable findings worth fixing now.
- Do not invent issues when the change looks acceptable.
- Prefer high-signal findings over minor style commentary.
- Return JSON only. No markdown fences and no prose outside the JSON.

Required JSON shape:
{
  "findings": [
    {
      "id": "finding-1",
      "category": "regression",
      "severity": "medium",
      "summary": "Short finding summary",
      "details": "Why this matters and what is wrong",
      "suggestedFix": "Concrete fix to apply",
      "paths": ["relative/path.ts"]
    }
  ],
  "checksRun": [
    {
      "command": "model-review",
      "source": "provider/model",
      "status": "passed",
      "summary": "Short result summary"
    }
  ],
  "unresolvedRisks": ["Optional remaining concern"],
  "overallAssessment": "Short overall assessment"
}`;

export interface ReviewModelFinding {
	model: string;
	finding: CheckerFinding;
}

export interface DeduplicatedReviewFinding {
	key: string;
	category: CheckerFinding["category"];
	severity: CheckerFinding["severity"];
	summary: string;
	details: string;
	suggestedFixes: string[];
	paths: string[];
	reporters: ReviewModelFinding[];
}

interface ReviewTarget {
	label: string;
	repoRoot: string;
	reviewCwd: string;
	changedFiles: string[];
	attachments: string[];
	cleanup?: () => Promise<void>;
}

interface ModelReviewRun {
	model: string;
	report?: ReturnType<typeof parseCheckerReport>;
	error?: string;
}

function modelRef(model: { provider: string; id: string } | null | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function runChecked(exec: ExecLike, cwd: string, command: string, args: string[]): Promise<string> {
	const result = await exec(command, args, { cwd, timeout: 60_000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to run ${command} ${args.join(" ")}`);
	}
	return result.stdout;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function severityRank(severity: CheckerFinding["severity"]): number {
	switch (severity) {
		case "high":
			return 3;
		case "medium":
			return 2;
		default:
			return 1;
	}
}

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`"'()\[\]{}:;,.!?/\\_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(text: string): string[] {
	return uniqueStrings(normalizeText(text).split(" ").filter((token) => token.length >= 3));
}

function similarityScore(left: string, right: string): number {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
	const leftSet = new Set(leftTokens);
	const rightSet = new Set(rightTokens);
	let overlap = 0;
	for (const token of leftSet) {
		if (rightSet.has(token)) overlap += 1;
	}
	return overlap / Math.max(leftSet.size, rightSet.size);
}

function findingsLookEquivalent(left: CheckerFinding, right: CheckerFinding): boolean {
	if (left.category !== right.category) return false;
	if (!pathsOverlap(left.paths, right.paths)) return false;
	const leftSummary = normalizeText(left.summary);
	const rightSummary = normalizeText(right.summary);
	if (!leftSummary || !rightSummary) return false;
	if (leftSummary === rightSummary) return true;
	if (leftSummary.includes(rightSummary) || rightSummary.includes(leftSummary)) return true;
	return similarityScore(`${left.summary} ${left.details}`, `${right.summary} ${right.details}`) >= 0.4;
}

function findingSortKey(finding: DeduplicatedReviewFinding): string {
	return `${4 - severityRank(finding.severity)}-${finding.summary.toLowerCase()}`;
}

function chooseRepresentativeText(values: string[], fallback: string): string {
	const deduped = uniqueStrings(values);
	if (deduped.length === 0) return fallback;
	return [...deduped].sort((left, right) => left.length - right.length || left.localeCompare(right))[0] ?? fallback;
}

export function deduplicateReviewFindings(runs: Array<{ model: string; findings: CheckerFinding[] }>): DeduplicatedReviewFinding[] {
	const deduplicated: DeduplicatedReviewFinding[] = [];

	for (const run of runs) {
		for (const finding of run.findings) {
			const existing = deduplicated.find((candidate) => findingsLookEquivalent(candidate.reporters[0].finding, finding));
			if (!existing) {
				deduplicated.push({
					key: `${finding.category}:${normalizeText(finding.summary)}:${finding.paths.join(",")}`,
					category: finding.category,
					severity: finding.severity,
					summary: finding.summary,
					details: finding.details,
					suggestedFixes: uniqueStrings([finding.suggestedFix]),
					paths: uniqueStrings(finding.paths),
					reporters: [{ model: run.model, finding }],
				});
				continue;
			}

			existing.reporters.push({ model: run.model, finding });
			existing.paths = uniqueStrings([...existing.paths, ...finding.paths]);
			existing.suggestedFixes = uniqueStrings([...existing.suggestedFixes, finding.suggestedFix]);
			if (severityRank(finding.severity) > severityRank(existing.severity)) existing.severity = finding.severity;
			existing.summary = chooseRepresentativeText(
				[existing.summary, ...existing.reporters.map((reporter) => reporter.finding.summary)],
				existing.summary,
			);
			existing.details = chooseRepresentativeText(
				[existing.details, ...existing.reporters.map((reporter) => reporter.finding.details)],
				existing.details,
			);
		}
	}

	return deduplicated.sort((left, right) => findingSortKey(left).localeCompare(findingSortKey(right)));
}

function renderFindingLine(index: number, finding: DeduplicatedReviewFinding): string[] {
	const lines = [`${index + 1}. [${finding.severity.toUpperCase()}] [${finding.category}] ${finding.summary}`];
	if (finding.paths.length > 0) lines.push(`   Paths: ${finding.paths.join(", ")}`);
	lines.push(`   Reported by: ${uniqueStrings(finding.reporters.map((reporter) => reporter.model)).join(", ")}`);
	for (const reporter of finding.reporters) {
		const detailBits = uniqueStrings([reporter.finding.details, reporter.finding.suggestedFix]).join(" Suggested fix: ");
		lines.push(`   - ${reporter.model}: ${detailBits || reporter.finding.summary}`);
	}
	if (finding.suggestedFixes.length > 0) lines.push(`   Combined suggested fix: ${finding.suggestedFixes.join(" | ")}`);
	return lines;
}

function buildReviewSummary(options: {
	target: ReviewTarget;
	implementationModel?: string;
	reviewerModels: string[];
	runs: ModelReviewRun[];
	findings: DeduplicatedReviewFinding[];
}): string {
	const lines = [
		"## Review summary",
		"",
		`- Scope: ${options.target.label}`,
		`- Implementation model: ${options.implementationModel ?? "unknown"}`,
		`- Reviewer models: ${options.reviewerModels.length > 0 ? options.reviewerModels.join(", ") : "none available"}`,
		`- Changed files: ${options.target.changedFiles.length}`,
		"",
		"## Reviewer run status",
		"",
	];

	for (const run of options.runs) {
		if (run.error) lines.push(`- ${run.model}: error - ${run.error}`);
		else lines.push(`- ${run.model}: ${run.report?.findings.length ?? 0} finding(s) • ${run.report?.overallAssessment || "completed"}`);
	}

	lines.push("", `## Deduplicated findings (${options.findings.length})`, "");
	if (options.findings.length === 0) {
		lines.push("No concrete fix-now findings were reported.");
	} else {
		for (const [index, finding] of options.findings.entries()) {
			lines.push(...renderFindingLine(index, finding), "");
		}
	}

	return lines.join("\n").trim();
}

function buildApplyPrompt(options: {
	target: ReviewTarget;
	implementationModel?: string;
	selectedFindings: DeduplicatedReviewFinding[];
}): string {
	const lines = [
		`Review target: ${options.target.label}`,
		`Implementation model: ${options.implementationModel ?? "unknown"}`,
		"",
		"A review command already ran two other top-level models against this change and deduplicated the findings.",
		"Address only the selected findings below.",
		"Do not ask whether to proceed. Do not reopen unrelated design or planning questions.",
		"After making the edits, summarize what you changed and note any selected finding you could not fully address.",
		"",
		"Selected review findings:",
		"",
	];

	for (const [index, finding] of options.selectedFindings.entries()) {
		lines.push(...renderFindingLine(index, finding), "");
	}

	return lines.join("\n").trim();
}

async function writeSnapshotFile(root: string, relativePath: string, content: string): Promise<string> {
	const destination = join(root, relativePath);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, content, "utf8");
	return destination;
}

async function snapshotJjChange(options: {
	exec: ExecLike;
	repoRoot: string;
	revision: string;
	changedFiles: string[];
	diffText: string;
	label: string;
}): Promise<ReviewTarget> {
	const snapshotRoot = await mkdtemp(join(tmpdir(), "guided-review-"));
	const attachments: string[] = [];
	attachments.push(await writeSnapshotFile(snapshotRoot, "review-target.md", `# Review target\n\n${options.label}\n`));
	attachments.push(await writeSnapshotFile(snapshotRoot, "review-diff.patch", options.diffText));
	attachments.push(
		await writeSnapshotFile(
			snapshotRoot,
			"review-changed-files.md",
			options.changedFiles.length > 0 ? options.changedFiles.map((file) => `- ${file}`).join("\n") : "No changed files detected.",
		),
	);

	for (const changedFile of options.changedFiles) {
		try {
			const contents = await runChecked(options.exec, options.repoRoot, "jj", ["file", "show", "-r", options.revision, changedFile]);
			attachments.push(await writeSnapshotFile(snapshotRoot, changedFile, contents));
		} catch {
			// Deleted files and binary-ish paths are still represented by the diff.
		}
	}

	const guidance = discoverRelevantGuidance(options.repoRoot, options.changedFiles);
	for (const document of guidance.documents) {
		attachments.push(await writeSnapshotFile(snapshotRoot, document.relativePath, document.content));
	}

	return {
		label: options.label,
		repoRoot: options.repoRoot,
		reviewCwd: snapshotRoot,
		changedFiles: options.changedFiles,
		attachments,
		cleanup: async () => {
			await rm(snapshotRoot, { recursive: true, force: true });
		},
	};
}

async function snapshotGitChange(options: {
	exec: ExecLike;
	repoRoot: string;
	revision: string;
	changedFiles: string[];
	diffText: string;
	label: string;
}): Promise<ReviewTarget> {
	const snapshotRoot = await mkdtemp(join(tmpdir(), "guided-review-"));
	const attachments: string[] = [];
	attachments.push(await writeSnapshotFile(snapshotRoot, "review-target.md", `# Review target\n\n${options.label}\n`));
	attachments.push(await writeSnapshotFile(snapshotRoot, "review-diff.patch", options.diffText));
	attachments.push(
		await writeSnapshotFile(
			snapshotRoot,
			"review-changed-files.md",
			options.changedFiles.length > 0 ? options.changedFiles.map((file) => `- ${file}`).join("\n") : "No changed files detected.",
		),
	);

	for (const changedFile of options.changedFiles) {
		try {
			const contents = await runChecked(options.exec, options.repoRoot, "git", ["show", `${options.revision}:${changedFile}`]);
			attachments.push(await writeSnapshotFile(snapshotRoot, changedFile, contents));
		} catch {
			// Deleted files and binary-ish paths are still represented by the diff.
		}
	}

	const guidance = discoverRelevantGuidance(options.repoRoot, options.changedFiles);
	for (const document of guidance.documents) {
		attachments.push(await writeSnapshotFile(snapshotRoot, document.relativePath, document.content));
	}

	return {
		label: options.label,
		repoRoot: options.repoRoot,
		reviewCwd: snapshotRoot,
		changedFiles: options.changedFiles,
		attachments,
		cleanup: async () => {
			await rm(snapshotRoot, { recursive: true, force: true });
		},
	};
}

async function prepareCurrentReviewTarget(exec: ExecLike, cwd: string): Promise<ReviewTarget> {
	const repoRoot = findRepoRootOrSelf(cwd);
	const repoKind = detectRepoKind(cwd);
	const changedFiles = await detectChangedFiles(cwd, exec);
	if (changedFiles.length === 0) {
		throw new Error("No uncommitted changes found to review.");
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "guided-review-"));
	const attachments: string[] = [];
	let diffText = "";

	if (repoKind === "jj") {
		diffText = await runChecked(exec, repoRoot, "jj", ["diff", "--git", "--context", "5"]);
	} else if (repoKind === "git") {
		diffText = await runChecked(exec, repoRoot, "git", ["diff", "--relative", "--find-renames", "--patch", "--stat"]);
	} else {
		throw new Error(`Unsupported repository type at ${repoRoot}`);
	}

	attachments.push(await writeSnapshotFile(tempRoot, "review-target.md", "# Review target\n\nUncommitted changes in the current working copy.\n"));
	attachments.push(await writeSnapshotFile(tempRoot, "review-diff.patch", diffText));
	attachments.push(
		await writeSnapshotFile(tempRoot, "review-changed-files.md", changedFiles.map((file) => `- ${file}`).join("\n")),
	);

	for (const changedFile of changedFiles) {
		const absolutePath = resolve(repoRoot, changedFile);
		if (await pathExists(absolutePath)) attachments.push(absolutePath);
	}

	const guidance = discoverRelevantGuidance(repoRoot, changedFiles);
	for (const document of guidance.documents) {
		attachments.push(document.path);
	}

	return {
		label: "uncommitted changes",
		repoRoot,
		reviewCwd: repoRoot,
		changedFiles,
		attachments: uniqueStrings(attachments),
		cleanup: async () => {
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}

async function prepareSpecifiedReviewTarget(exec: ExecLike, cwd: string, revision: string): Promise<ReviewTarget> {
	const repo = findRepoLocation(cwd);
	if (!repo) throw new Error(`No jj or git repository detected from ${cwd}`);

	if (repo.kind === "jj") {
		const changedFiles = parseGitDiffNameOnly(await runChecked(exec, repo.root, "jj", ["diff", "-r", revision, "--name-only"]));
		if (changedFiles.length === 0) throw new Error(`Change ${revision} has no file changes to review.`);
		const diffText = await runChecked(exec, repo.root, "jj", ["show", revision, "--git", "--context", "5"]);
		const label = (
			await runChecked(exec, repo.root, "jj", [
				"log",
				"-r",
				revision,
				"--no-graph",
				"-T",
				'change_id.short(8) ++ " • " ++ description.first_line()',
			])
		).trim() || `change ${revision}`;
		return await snapshotJjChange({ exec, repoRoot: repo.root, revision, changedFiles, diffText, label });
	}

	const changedFiles = parseGitDiffNameOnly(
		await runChecked(exec, repo.root, "git", ["show", "--name-only", "--format=", "--relative", revision]),
	);
	if (changedFiles.length === 0) throw new Error(`Revision ${revision} has no file changes to review.`);
	const diffText = await runChecked(exec, repo.root, "git", [
		"show",
		"--format=medium",
		"--stat",
		"--patch",
		"--find-renames",
		"--relative",
		revision,
	]);
	const label = (await runChecked(exec, repo.root, "git", ["show", "-s", "--format=%h • %s", revision])).trim() || revision;
	return await snapshotGitChange({ exec, repoRoot: repo.root, revision, changedFiles, diffText, label });
}

async function prepareReviewTarget(exec: ExecLike, cwd: string, args: string): Promise<ReviewTarget> {
	const revision = args.trim();
	if (!revision) return await prepareCurrentReviewTarget(exec, cwd);
	return await prepareSpecifiedReviewTarget(exec, cwd, revision);
}

async function runModelReview(options: {
	target: ReviewTarget;
	model: string;
	thinkingLevel?: string;
}): Promise<ModelReviewRun> {
	try {
		const result = await runSubagent({
			cwd: options.target.reviewCwd,
			systemPrompt: REVIEW_SYSTEM_PROMPT,
			prompt:
				"Review the attached change. Use the diff, changed-file snapshots, and any attached AGENTS.md guidance. Inspect nearby code only if needed. Return JSON only.",
			files: options.target.attachments,
			tools: REVIEW_TOOLS,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
		});
		if (result.exitCode !== 0 && !result.assistantText.trim()) {
			return {
				model: options.model,
				error: result.errorMessage || result.stderr.trim() || `Review process exited with code ${result.exitCode}`,
			};
		}
		return { model: options.model, report: parseCheckerReport(result.assistantText) };
	} catch (error) {
		return {
			model: options.model,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function chooseFindingsToAddress(
	ctx: ExtensionContext,
	findings: DeduplicatedReviewFinding[],
): Promise<DeduplicatedReviewFinding[]> {
	if (!ctx.hasUI || findings.length === 0) return [];

	const firstChoice = await ctx.ui.select("Review finished. What should happen with the findings?", [
		"Address all findings",
		"Choose findings individually",
		"Do not address findings now",
	]);
	if (firstChoice === "Address all findings") return findings;
	if (firstChoice !== "Choose findings individually") return [];

	const selected: DeduplicatedReviewFinding[] = [];
	for (const [index, finding] of findings.entries()) {
		const prompt = [
			`${index + 1}. [${finding.severity.toUpperCase()}] [${finding.category}] ${finding.summary}`,
			finding.paths.length > 0 ? `Paths: ${finding.paths.join(", ")}` : "Paths: (not specified)",
			`Reported by: ${uniqueStrings(finding.reporters.map((reporter) => reporter.model)).join(", ")}`,
		].join("\n");
		const choice = await ctx.ui.select(prompt, ["Address this finding", "Skip this finding"]);
		if (choice === "Address this finding") selected.push(finding);
	}
	return selected;
}

function setRunningReviewUi(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(REVIEW_STATUS_KEY, ctx.ui.theme.fg("accent", "🔎 review"));
	ctx.ui.setWidget(REVIEW_WIDGET_KEY, [ctx.ui.theme.fg("accent", "Cross-model review"), ctx.ui.theme.fg("dim", message)]);
}

function clearReviewUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
	ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
}

export default function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description:
			"Review uncommitted changes or a specified change with the two other top-level models, deduplicate the findings, and optionally send selected fixes back to the main session",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				if (ctx.hasUI) ctx.ui.notify("Wait until the agent is idle before starting a review.", "warning");
				else console.error("Wait until the agent is idle before starting a review.");
				return;
			}

			const exec = makeExec(pi);
			const modelPlan = resolveReviewModels(ctx);
			if (modelPlan.reviewers.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No alternate reviewer models are available right now.", "warning");
				else console.error("No alternate reviewer models are available right now.");
				return;
			}

			let target: ReviewTarget | null = null;
			try {
				target = await prepareReviewTarget(exec, ctx.cwd, args);
				setRunningReviewUi(
					ctx,
					`Reviewing ${target.label} with ${modelPlan.reviewers.join(", ")} against ${modelPlan.implementation ?? modelRef(ctx.model) ?? "the current implementation model"}.`,
				);
				if (ctx.hasUI) ctx.ui.notify(`Running review for ${target.label}`, "info");

				const thinkingLevel = pi.getThinkingLevel() || undefined;
				const runs = await Promise.all(
					modelPlan.reviewers.map((model) =>
						runModelReview({
							target,
							model,
							thinkingLevel,
						}),
					),
				);

				const findings = deduplicateReviewFindings(
					runs.filter((run): run is ModelReviewRun & { report: NonNullable<ModelReviewRun["report"]> } => Boolean(run.report)).map((run) => ({
						model: run.model,
						findings: run.report.findings,
					})),
				);

				const summary = buildReviewSummary({
					target,
					implementationModel: modelPlan.implementation ?? modelRef(ctx.model),
					reviewerModels: modelPlan.reviewers,
					runs,
					findings,
				});

				pi.sendMessage(
					{
						customType: "guided-review-summary",
						content: summary,
						display: true,
					},
					{ triggerTurn: false },
				);

				const selectedFindings = await chooseFindingsToAddress(ctx, findings);
				if (selectedFindings.length === 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							findings.length === 0 ? "Review found no concrete fix-now issues." : "No review findings selected for follow-up.",
							findings.length === 0 ? "success" : "info",
						);
					}
					return;
				}

				pi.sendUserMessage(
					buildApplyPrompt({
						target,
						implementationModel: modelPlan.implementation ?? modelRef(ctx.model),
						selectedFindings,
					}),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Review failed: ${message}`, "error");
				else console.error(`Review failed: ${message}`);
			} finally {
				clearReviewUi(ctx);
				await target?.cleanup?.().catch(() => {});
			}
		},
	});
}
