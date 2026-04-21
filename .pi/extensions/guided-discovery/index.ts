import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { padToWidth, truncateToWidth, visibleWidth } from "./tui-compat.ts";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecLike } from "./changes.ts";
import {
	parseImplementationRequest,
	runGuidedDiscoveryImplementationWorkflow,
	type ImplementationMode,
	type ResumableImplementationState,
	type SubagentWorkflowMode,
} from "./implement-workflow.ts";
import {
	createImplementationProgressState,
	reduceImplementationProgress,
	type ImplementationProgressState,
	type WorkflowProgressUpdate,
} from "./implementation-progress.ts";
import { createImplementationProgressWidget } from "./implementation-progress-widget.ts";
import type { SubagentUsageTotals } from "./subagent-runner.ts";
import registerQuestionnaire from "./questionnaire.ts";
import { buildUsageDisplay, formatTokens, hasUsageTotals } from "./usage-display.ts";
import { supportsStructuredImplementationWidget } from "./widget-support.ts";
import { buildImplementationPrompt, isRedundantImplementationKickoffQuestionnaire } from "./implementation-prompt.ts";
import {
	type ResearchSource,
	hashText,
	isFinalPlanResponse,
	isSafeCommand,
	mergeResearchSources,
	renderPlanDocument,
} from "./utils.ts";
import registerWebResearch from "./web-research.ts";
import { detectRepoKind, findRepoLocation, formatJjRepoMetadata, readJjRepoMetadata, type JjRepoMetadata } from "./repo.ts";
import {
	createManagedWorkspace,
	reviveManagedWorkspace,
	serializeManagedWorkspace,
	type ManagedWorkspace,
	type SerializedManagedWorkspace,
} from "./workspaces.ts";

const DISCOVERY_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "web_research"];
const DEFAULT_IMPLEMENTATION_TOOLS = ["read", "bash", "edit", "write", "questionnaire"];
const PLAN_FILE = "PLAN.md";
const STATE_TYPE = "guided-discovery-state";
const STATUS_KEY = "guided-discovery";
const WIDGET_KEY = "guided-discovery";

const DISCOVERY_PROMPT_APPEND = `
[Guided discovery mode]
You are in a research-first planning workflow that should stay concise, decisive, and implementation-oriented.

Your job in this mode:
1. Start with a fast repo scan using read-only tools. Inspect the existing code, architecture, tests, docs, and conventions before proposing changes.
2. If the request references an existing product, third-party API, external ecosystem, market pattern, or greenfield product behavior, proactively use web_research early. Prefer official docs and first-party sources.
3. Research enough to make good decisions yourself. Do not wait for the user to explicitly ask for obvious state-of-the-art or product-context research.
4. Surface the real trade-offs. Recommend a concrete default when the repo and research point to one. Do not expand into a broad option dump.
5. For broad ideas, ambiguous features, or product-shaping requests, proactively ask a focused questionnaire batch before finalizing. Use it to confirm the core point of the idea, important side effects, and the key decisions that would materially change implementation.
6. If the user needs to choose between materially different viable paths, use questionnaire instead of burying alternatives in prose. Put the recommended option first and mark it as recommended.
7. Ask at most one focused questionnaire batch at a time. Prefer concrete, high-signal questions over open-ended chatting, but do not skip the questions when the idea still needs shaping.
8. Keep interim summaries short. Do not narrate every micro-step of planning or research.
9. For remote websites and product references, prefer web_research over ad-hoc scraping.
10. Favor simple, proven approaches over elaborate agent-generated architecture.
11. Do not implement or modify files while this mode is active.
12. Do not leave unresolved forks in the final plan. If a decision still needs the user's choice, ask it explicitly with questionnaire before finalizing.
13. Before finalizing, make sure you and the user have explicitly covered: the real user outcome, major scope boundaries, likely side effects/regression risks, and any decision that changes how the feature should be built.
14. Once the plan is implementation-ready, respond with these exact sections:
    ## Problem
    ## Key findings
    ## Options and trade-offs
    ## Recommended approach
    ## Build plan
    ## Acceptance checks
    ## Risks / follow-ups
    ## TL;DR
    In the final plan, keep only the agreed path. Under "Options and trade-offs", summarize only the selected direction and why it won; do not restate rejected alternatives unless the user explicitly asks for them. In ## TL;DR, give a very short end-of-plan summary that is easy to spot after terminal scrollback.
15. If the user clearly wants to start coding, tell them to run /discover-implement or /discover-off first.
`;

interface SavedState {
	enabled?: boolean;
	previousActiveTools?: string[] | null;
	lastSavedPlanSignature?: string | null;
	lastSavedPlanDocument?: string | null;
	researchSources?: ResearchSource[] | null;
	questionnaireBatchCount?: number;
	subagentUsageTotals?: SubagentUsageTotals | null;
	discoveryWorkspace?: SerializedManagedWorkspace | null;
	resumableImplementation?: ResumableImplementationState | null;
}

function emptySubagentUsageTotals(): SubagentUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

function addSubagentUsageTotals(total: SubagentUsageTotals, delta: SubagentUsageTotals): SubagentUsageTotals {
	return {
		input: total.input + delta.input,
		output: total.output + delta.output,
		cacheRead: total.cacheRead + delta.cacheRead,
		cacheWrite: total.cacheWrite + delta.cacheWrite,
		totalTokens: total.totalTokens + delta.totalTokens,
		cost: total.cost + delta.cost,
		turns: total.turns + delta.turns,
	};
}

function normalizeToolList(names: string[] | null | undefined): string[] | null {
	if (!names || names.length === 0) return null;
	return [...new Set(names)];
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function getLastAssistantText(messages: AgentMessage[]): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (isAssistantMessage(message)) {
			const text = getAssistantText(message);
			if (text) return text;
		}
	}
	return null;
}

function extractResearchSourcesFromEntries(entries: Array<{ type: string; message?: unknown }>): ResearchSource[] {
	let sources: ResearchSource[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as {
			role?: string;
			toolName?: string;
			details?: { sources?: ResearchSource[] };
		};
		if (message.role !== "toolResult" || message.toolName !== "web_research") continue;
		if (!Array.isArray(message.details?.sources) || message.details.sources.length === 0) continue;
		sources = mergeResearchSources(sources, message.details.sources);
	}
	return sources;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isPrintModeProcess(): boolean {
	return process.argv.includes("-p") || process.argv.includes("--print");
}

function displayPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export default function guidedDiscovery(pi: ExtensionAPI): void {
	registerQuestionnaire(pi);
	registerWebResearch(pi);

	let enabled = false;
	let directImplementationKickoffPending = false;
	let previousActiveTools: string[] | null = null;
	let researchSources: ResearchSource[] = [];
	let questionnaireBatchCount = 0;
	let lastSavedPlanSignature: string | null = null;
	let lastSavedPlanDocument: string | null = null;
	let subagentUsageTotals = emptySubagentUsageTotals();
	let subagentWorkflowActive = false;
	let ownsFooter = false;
	let discoveryWorkspace: ManagedWorkspace | null = null;
	let discoveryWorkspaceState: SerializedManagedWorkspace | null = null;
	let discoveryWorkspacePromise: Promise<ManagedWorkspace> | null = null;
	let resumableImplementationState: ResumableImplementationState | null = null;
	let jjFooterMetadataState:
		| {
				repoRoot: string;
				metadata: JjRepoMetadata | null;
				loading: boolean;
				error: string | null;
				request: Promise<void> | null;
		  }
		| null = null;

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, {
			enabled,
			previousActiveTools,
			lastSavedPlanSignature,
			lastSavedPlanDocument,
			researchSources,
			questionnaireBatchCount,
			subagentUsageTotals,
			discoveryWorkspace: discoveryWorkspace ? serializeManagedWorkspace(discoveryWorkspace) : discoveryWorkspaceState,
			resumableImplementation: resumableImplementationState,
		} satisfies SavedState);
	}

	function makeExec(): ExecLike {
		return async (command, args, options) => {
			const result = await pi.exec(command, args, options);
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				code: result.code,
			};
		};
	}

	function getWorkspaceWorkflowCwd(workspace: Pick<ManagedWorkspace, "repoRoot" | "sourceRelativeCwd">): string {
		return resolve(workspace.repoRoot, workspace.sourceRelativeCwd);
	}

	function invalidateJjFooterMetadata(cwd?: string): void {
		const repoLocation = cwd ? findRepoLocation(cwd) : null;
		if (!repoLocation || repoLocation.kind !== "jj") {
			jjFooterMetadataState = null;
			return;
		}
		jjFooterMetadataState = {
			repoRoot: repoLocation.root,
			metadata: null,
			loading: false,
			error: null,
			request: null,
		};
	}

	function getRepoChromeLabel(cwd: string, gitBranch: string | null, requestRender: () => void): string | null {
		const repoLocation = findRepoLocation(cwd);
		if (!repoLocation) {
			jjFooterMetadataState = null;
			return gitBranch;
		}
		if (repoLocation.kind !== "jj") {
			jjFooterMetadataState = null;
			return gitBranch;
		}
		if (!jjFooterMetadataState || jjFooterMetadataState.repoRoot !== repoLocation.root) {
			invalidateJjFooterMetadata(repoLocation.root);
		}
		const state = jjFooterMetadataState;
		if (state && !state.loading && !state.metadata && !state.error) {
			state.loading = true;
			state.request = readJjRepoMetadata(repoLocation.root, makeExec())
				.then((metadata) => {
					if (!jjFooterMetadataState || jjFooterMetadataState.repoRoot !== repoLocation.root) return;
					jjFooterMetadataState.metadata = metadata;
					jjFooterMetadataState.error = metadata ? null : "unavailable";
				})
				.catch((error) => {
					if (!jjFooterMetadataState || jjFooterMetadataState.repoRoot !== repoLocation.root) return;
					jjFooterMetadataState.error = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					if (jjFooterMetadataState?.repoRoot === repoLocation.root) {
						jjFooterMetadataState.loading = false;
						jjFooterMetadataState.request = null;
					}
					requestRender();
				});
		}
		if (state?.metadata) return formatJjRepoMetadata(state.metadata);
		if (state?.loading) return "jj …";
		return "jj";
	}

	function getDiscoveryWorkflowCwd(workspace: ManagedWorkspace): string {
		return getWorkspaceWorkflowCwd(workspace);
	}

	function getDiscoveryPlanPath(workspace: Pick<ManagedWorkspace, "repoRoot" | "sourceRelativeCwd">): string {
		return resolve(getWorkspaceWorkflowCwd(workspace), PLAN_FILE);
	}

	function mapPathIntoDiscoveryWorkspace(rawPath: string, workspace: ManagedWorkspace): string {
		const trimmedPath = rawPath.trim();
		if (!trimmedPath) return getDiscoveryWorkflowCwd(workspace);
		const workflowCwd = getDiscoveryWorkflowCwd(workspace);
		const normalizedPath = trimmedPath.startsWith("@") ? trimmedPath.slice(1) : trimmedPath;
		if (normalizedPath.startsWith(workspace.sourceRepoRoot)) {
			const relativePath = normalizedPath.slice(workspace.sourceRepoRoot.length).replace(/^\/+/, "");
			return resolve(workspace.repoRoot, relativePath);
		}
		if (normalizedPath.startsWith(workspace.sourceCwd)) {
			const relativePath = normalizedPath.slice(workspace.sourceCwd.length).replace(/^\/+/, "");
			return resolve(workflowCwd, relativePath);
		}
		if (normalizedPath.startsWith("/")) return normalizedPath;
		return resolve(workflowCwd, normalizedPath);
	}

	async function restorePlanIntoWorkspace(workspace: ManagedWorkspace): Promise<void> {
		if (!lastSavedPlanDocument?.trim()) return;
		await writeFile(getDiscoveryPlanPath(workspace), lastSavedPlanDocument, "utf8");
	}

	async function ensureDiscoveryWorkspace(ctx: ExtensionContext): Promise<ManagedWorkspace> {
		if (discoveryWorkspace) return discoveryWorkspace;
		if (discoveryWorkspacePromise) return await discoveryWorkspacePromise;
		discoveryWorkspacePromise = (async () => {
			const exec = makeExec();
			if (discoveryWorkspaceState) {
				try {
					const revived = await reviveManagedWorkspace({ exec, state: discoveryWorkspaceState });
					discoveryWorkspace = revived;
					await restorePlanIntoWorkspace(revived);
					persistState();
					return revived;
				} catch {
					discoveryWorkspace = null;
					discoveryWorkspaceState = null;
				}
			}
			const { workspace } = await createManagedWorkspace({
				exec,
				sourceCwd: ctx.cwd,
				label: "discover",
			});
			discoveryWorkspace = workspace;
			discoveryWorkspaceState = serializeManagedWorkspace(workspace);
			await restorePlanIntoWorkspace(workspace);
			persistState();
			return workspace;
		})().finally(() => {
			discoveryWorkspacePromise = null;
		});
		const workspace = await discoveryWorkspacePromise;
		updateUi(ctx);
		return workspace;
	}

	async function cleanupDiscoveryWorkspace(
		ctx: ExtensionContext,
		options?: { clearSavedPlan?: boolean; cleanupOriginalPlanFile?: boolean },
	): Promise<void> {
		const shouldCleanupOriginalPlan = options?.cleanupOriginalPlanFile === true;
		const shouldClearSavedPlan = options?.clearSavedPlan === true;
		try {
			if (shouldCleanupOriginalPlan && lastSavedPlanSignature) {
				const originalPlanPath = resolve(ctx.cwd, PLAN_FILE);
				if (await fileExists(originalPlanPath)) {
					const currentPlan = await readFile(originalPlanPath, "utf8").catch(() => "");
					if (currentPlan && hashText(currentPlan) === lastSavedPlanSignature) {
						await rm(originalPlanPath, { force: true });
					}
				}
			}
			if (discoveryWorkspace) {
				await discoveryWorkspace.cleanup().catch(() => {});
			}
		} finally {
			discoveryWorkspace = null;
			discoveryWorkspaceState = null;
			if (shouldClearSavedPlan) {
				lastSavedPlanSignature = null;
				lastSavedPlanDocument = null;
			}
			persistState();
			updateUi(ctx);
		}
	}

	async function getApprovedPlanSource(ctx: ExtensionContext): Promise<
		| { hasPlan: true; path: string; displayPath: string; source: "workspace" | "cwd" }
		| { hasPlan: false; source: "none" }
	> {
		if (lastSavedPlanSignature || lastSavedPlanDocument || discoveryWorkspace || discoveryWorkspaceState) {
			const workspace = await ensureDiscoveryWorkspace(ctx);
			const planPath = getDiscoveryPlanPath(workspace);
			if (lastSavedPlanDocument?.trim() && !(await fileExists(planPath))) {
				await writeFile(planPath, lastSavedPlanDocument, "utf8");
			}
			if (await fileExists(planPath)) {
				return { hasPlan: true, path: planPath, displayPath: displayPath(planPath), source: "workspace" };
			}
		}
		const cwdPlanPath = resolve(ctx.cwd, PLAN_FILE);
		if (await fileExists(cwdPlanPath)) {
			return { hasPlan: true, path: cwdPlanPath, displayPath: PLAN_FILE, source: "cwd" };
		}
		return { hasPlan: false, source: "none" };
	}

	function getResumableImplementationWorkflowCwd(state: ResumableImplementationState): string {
		return getWorkspaceWorkflowCwd(state.workspace);
	}

	function sameResumableWorkspace(
		left: ResumableImplementationState | null | undefined,
		right: ResumableImplementationState | null | undefined,
	): boolean {
		return Boolean(left?.workspace.cwd && right?.workspace.cwd && left.workspace.cwd === right.workspace.cwd);
	}

	async function cleanupResumableImplementationWorkspace(state: ResumableImplementationState | null | undefined): Promise<void> {
		if (!state) return;
		try {
			const workspace = await reviveManagedWorkspace({ exec: makeExec(), state: state.workspace });
			await workspace.cleanup().catch(() => {});
		} catch {
			// Best-effort only. Missing or already-cleaned workspaces should not surface as hard errors here.
		}
	}

	async function replaceResumableImplementationState(
		ctx: ExtensionContext,
		nextState: ResumableImplementationState | null,
		options?: { cleanupPrevious?: boolean; previousState?: ResumableImplementationState | null },
	): Promise<void> {
		const previousState = options?.previousState ?? resumableImplementationState;
		resumableImplementationState = nextState;
		persistState();
		updateUi(ctx);
		if (options?.cleanupPrevious && previousState && !sameResumableWorkspace(previousState, nextState)) {
			await cleanupResumableImplementationWorkspace(previousState);
		}
	}

	function collectSessionAssistantUsage(ctx: ExtensionContext): SubagentUsageTotals {
		let total = emptySubagentUsageTotals();
		const entries = ctx.sessionManager.getEntries() as any[];
		for (const entry of entries) {
			if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
			const message = entry.message as AssistantMessage;
			total = addSubagentUsageTotals(total, {
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				totalTokens: message.usage.totalTokens,
				cost: message.usage.cost.total,
				turns: 1,
			});
		}
		return total;
	}

	function buildCurrentUsageDisplay(ctx: ExtensionContext) {
		const sessionUsage = collectSessionAssistantUsage(ctx);
		const totalUsage = addSubagentUsageTotals(sessionUsage, subagentUsageTotals);
		return buildUsageDisplay({
			sessionUsage,
			subagentUsage: subagentUsageTotals,
			totalUsage,
		});
	}

	function styleUsageSummaryLines(ctx: ExtensionContext, lines: string[]): string[] {
		return lines.map((line, index) => ctx.ui.theme.fg(index === 0 ? "muted" : "dim", line));
	}

	function sanitizeFooterText(text: string): string {
		const controlChars = [String.fromCharCode(13), String.fromCharCode(10), String.fromCharCode(9)];
		let value = text;
		for (const controlChar of controlChars) value = value.split(controlChar).join(" ");
		return value.replace(/ +/g, " ").trim();
	}

	function buildGuidedFooterLines(): string[] {
		const lines: string[] = [];
		const workspaceForDisplay = discoveryWorkspace ?? discoveryWorkspaceState;
		if (enabled) {
			const workspaceText = workspaceForDisplay
				? displayPath(getWorkspaceWorkflowCwd(workspaceForDisplay))
				: "preparing isolated workspace…";
			const planState = lastSavedPlanSignature ? "PLAN ready" : "planning";
			lines.push(`🧭 discovery • isolated workspace ${workspaceText} • ${planState}`);
		}
		if (resumableImplementationState) {
			lines.push(
				`🤖 resume ready • ${resumableImplementationState.workflowMode} • ${displayPath(getResumableImplementationWorkflowCwd(resumableImplementationState))} • /implement-subagents-resume`,
			);
		}
		return lines;
	}

	function syncUsageFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const guidedFooterLines = buildGuidedFooterLines();
		const shouldShowRepoChrome = detectRepoKind(ctx.sessionManager.getCwd()) === "jj";
		if (!subagentWorkflowActive && !hasUsageTotals(subagentUsageTotals) && guidedFooterLines.length === 0 && !shouldShowRepoChrome) {
			if (ownsFooter) {
				ctx.ui.setFooter(undefined);
				ownsFooter = false;
			}
			return;
		}

		ctx.ui.setFooter(function (tui, theme, footerData) {
			const dispose = footerData.onBranchChange(function () {
				invalidateJjFooterMetadata(ctx.sessionManager.getCwd());
				tui.requestRender();
			});

			return {
				dispose,
				invalidate() {},
				render(width: number): string[] {
					const usageDisplay = buildCurrentUsageDisplay(ctx);
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

					const sessionCwd = ctx.sessionManager.getCwd();
					let pwd = sessionCwd;
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
					const repoChromeLabel = getRepoChromeLabel(sessionCwd, footerData.getGitBranch(), () => tui.requestRender());
					if (repoChromeLabel) pwd += " (" + repoChromeLabel + ")";
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += " • " + sessionName;

					const statsParts = [...usageDisplay.footerParts];

					let contextDisplay = contextPercent === "?" ? "?/" + formatTokens(contextWindow) : contextPercent + "%/" + formatTokens(contextWindow);
					if (contextPercentValue < 70) {
						contextDisplay = theme.fg("dim", contextDisplay);
					} else if (contextPercentValue < 90) {
						contextDisplay = theme.fg("warning", contextDisplay);
					} else {
						contextDisplay = theme.fg("error", contextDisplay);
					}
					statsParts.push(contextDisplay);

					let statsLeft = theme.fg("dim", statsParts.join(" "));
					const baseModelName = ctx.model?.id || "no-model";
					let rightSide = baseModelName;
					if (ctx.model?.reasoning) {
						rightSide = baseModelName + " • " + (pi.getThinkingLevel() || "off");
					}
					if (footerData.getAvailableProviderCount() && footerData.getAvailableProviderCount() !== 1 && ctx.model) {
						rightSide = "(" + ctx.model.provider + ") " + rightSide;
					}
					rightSide = theme.fg("dim", rightSide);

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const statsLine = truncateToWidth(padToWidth(statsLeft, Math.max(0, width - visibleWidth(rightSide))) + rightSide, width);
					const lines = [pwdLine, statsLine];
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size) {
						const statusLine = Array.from(extensionStatuses.values()).map(sanitizeFooterText).join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					for (const footerLine of buildGuidedFooterLines()) {
						lines.push(truncateToWidth(theme.fg("muted", sanitizeFooterText(footerLine)), width, theme.fg("dim", "...")));
					}
					return lines;
				}
			};
		});
		ownsFooter = true;
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!enabled && !resumableImplementationState) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			syncUsageFooter(ctx);
			return;
		}

		const lines: string[] = [];
		if (enabled) {
			lines.push(ctx.ui.theme.fg("accent", "Guided discovery mode active"));
			lines.push(
				ctx.ui.theme.fg(
					"dim",
					"Mode: discovery (read-only, isolated workspace) • /discover-implement or /discover-off to start coding",
				),
			);
			const workspaceForDisplay = discoveryWorkspace ?? discoveryWorkspaceState;
			if (workspaceForDisplay) {
				lines.push(
					ctx.ui.theme.fg(
						"muted",
						`Discovery workspace: ${displayPath(getWorkspaceWorkflowCwd(workspaceForDisplay))}`,
					),
				);
			}
			lines.push(ctx.ui.theme.fg("muted", `Questionnaire batches answered: ${questionnaireBatchCount}`));
			if (researchSources.length > 0) {
				lines.push(ctx.ui.theme.fg("muted", `Captured external sources: ${researchSources.length}`));
			}
			if (lastSavedPlanSignature) {
				lines.push(
					ctx.ui.theme.fg(
						"success",
						workspaceForDisplay
							? `Latest final plan saved to ${displayPath(getDiscoveryPlanPath(workspaceForDisplay))}`
							: "Latest final plan saved to PLAN.md",
					),
				);
			}
		}
		if (resumableImplementationState) {
			lines.push(ctx.ui.theme.fg(enabled ? "warning" : "accent", "Resumable sub-agent workspace ready"));
			lines.push(
				ctx.ui.theme.fg(
					"dim",
					`Mode: resume ${resumableImplementationState.workflowMode} from preserved isolated workspace • /implement-subagents-resume to continue`,
				),
			);
			lines.push(
				ctx.ui.theme.fg(
					"muted",
					`Resume workspace: ${displayPath(getResumableImplementationWorkflowCwd(resumableImplementationState))}`,
				),
			);
		}
		lines.push(...styleUsageSummaryLines(ctx, buildCurrentUsageDisplay(ctx).widgetLines));

		ctx.ui.setStatus(
			STATUS_KEY,
			enabled
				? ctx.ui.theme.fg("accent", "🧭 discover")
				: ctx.ui.theme.fg("warning", `🤖 resume ${resumableImplementationState?.workflowMode ?? "ready"}`),
		);
		ctx.ui.setWidget(WIDGET_KEY, lines);
		syncUsageFooter(ctx);
	}

	function applyDiscoveryTools(): void {
		pi.setActiveTools(DISCOVERY_MODE_TOOLS);
	}

	function restoreTools(): void {
		const restored = normalizeToolList(previousActiveTools) ?? DEFAULT_IMPLEMENTATION_TOOLS;
		pi.setActiveTools(normalizeToolList([...restored, "questionnaire"]) ?? DEFAULT_IMPLEMENTATION_TOOLS);
	}

	async function resetDiscoveryProgress(ctx: ExtensionContext): Promise<void> {
		researchSources = [];
		questionnaireBatchCount = 0;
		lastSavedPlanSignature = null;
		lastSavedPlanDocument = null;
		const workspace = discoveryWorkspace ?? (discoveryWorkspaceState ? await ensureDiscoveryWorkspace(ctx).catch(() => null) : null);
		if (workspace) {
			await rm(getDiscoveryPlanPath(workspace), { force: true }).catch(() => {});
		}
	}

	async function enableDiscovery(ctx: ExtensionContext): Promise<void> {
		if (!enabled) {
			previousActiveTools = normalizeToolList(pi.getActiveTools().map((tool) => tool.name));
		}
		enabled = true;
		applyDiscoveryTools();
		persistState();
		updateUi(ctx);
		await ensureDiscoveryWorkspace(ctx).catch((error) => {
			const message = `Failed to prepare the isolated discovery workspace: ${error instanceof Error ? error.message : String(error)}`;
			surfaceWorkflowWarning(ctx, message);
		});
		updateUi(ctx);
	}

	async function disableDiscovery(ctx: ExtensionContext): Promise<void> {
		enabled = false;
		restoreTools();
		if (!lastSavedPlanSignature && !lastSavedPlanDocument) {
			await cleanupDiscoveryWorkspace(ctx, { clearSavedPlan: false, cleanupOriginalPlanFile: false });
			return;
		}
		updateUi(ctx);
		persistState();
	}

	function kickoffPrompt(goal: string): string {
		return [
			`Feature idea: ${goal}`,
			"",
			"Start guided discovery for this request.",
			"Do a fast repo scan first.",
			"If the request references an external product, API, ecosystem, or greenfield workflow, proactively do web research before planning.",
			"Before you finalize, ask me a focused questionnaire batch that gets to the real point of the idea, uncovers likely side effects, and flushes out any decision that would materially change implementation.",
			"Then make a concrete recommendation and keep the plan concise.",
		].join("\n");
	}

	function summarizeImplementationStage(stage: string): string {
		const [baseStage] = stage.split(":");
		switch (baseStage) {
			case "starting":
				return "starting";
			case "decomposer":
				return "decompose";
			case "worker":
				return "implement";
			case "cleanup":
			case "design":
			case "checker":
			case "fix":
				return "review";
			case "validator":
				return "coverage";
			case "complete":
			case "failed":
				return baseStage;
			default:
				return baseStage || "implement";
		}
	}

	function setImplementationProgress(
		ctx: ExtensionContext,
		stage: string,
		state: ImplementationProgressState,
		fallbackLines: string[],
	): void {
		const stageLabel = summarizeImplementationStage(stage);
		const usageSummaryLines = buildCurrentUsageDisplay(ctx).widgetLines;
		ctx.ui.setStatus(
			STATUS_KEY,
			state.failure
				? ctx.ui.theme.fg("error", "🤖 failed")
				: state.finished
					? ctx.ui.theme.fg("success", "🤖 complete")
					: ctx.ui.theme.fg("accent", `🤖 ${stageLabel}`),
		);

		if (supportsStructuredImplementationWidget(ctx)) {
			ctx.ui.setWidget(
				WIDGET_KEY,
				createImplementationProgressWidget(() => state, { usageSummaryLines }),
				{ placement: "aboveEditor" },
			);
			return;
		}

		const detailLines = state.detailLines.length > 0 ? state.detailLines : fallbackLines;
		ctx.ui.setWidget(
			WIDGET_KEY,
			[
				ctx.ui.theme.fg("accent", `Guided implementation • ${stageLabel}`),
				...styleUsageSummaryLines(ctx, usageSummaryLines),
				...detailLines.map((line) => ctx.ui.theme.fg("dim", line)),
			],
			{ placement: "aboveEditor" },
		);
	}

	function clearImplementationProgress(ctx: ExtensionContext): void {
		if (enabled || resumableImplementationState) updateUi(ctx);
		else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	type ImplementationSelection =
		| { mode: "direct" }
		| { mode: "subagents"; workflowMode: SubagentWorkflowMode }
		| { mode: "resume" };

	async function chooseImplementationMode(
		ctx: ExtensionContext,
		planSource: Awaited<ReturnType<typeof getApprovedPlanSource>>,
	): Promise<ImplementationSelection | null> {
		if (!ctx.hasUI) return null;
		if (!planSource.hasPlan) {
			const choices = resumableImplementationState
				? [`Resume stopped sub-agents (${resumableImplementationState.workflowMode})`, "Implement directly", "Cancel"]
				: ["Implement directly", "Cancel"];
			const choice = await ctx.ui.select(
				`No approved ${PLAN_FILE} is available yet. Direct mode will rely on the conversation history. Use /implement-subagents with a raw prompt if you want an isolated implementation workflow without a saved plan.`,
				choices,
			);
			if (choice === `Resume stopped sub-agents (${resumableImplementationState?.workflowMode ?? "fast"})`) return { mode: "resume" };
			return choice === "Implement directly" ? { mode: "direct" } : null;
		}
		const options = [
			...(resumableImplementationState ? [`Resume stopped sub-agents (${resumableImplementationState.workflowMode})`] : []),
			"Implement directly",
			"Implement with sub-agents (fast)",
			"Implement with sub-agents (strict)",
			"Cancel",
		];
		const choice = await ctx.ui.select(`Latest approved plan saved to ${planSource.displayPath}. Choose an implementation mode.`, options);
		if (choice === `Resume stopped sub-agents (${resumableImplementationState?.workflowMode ?? "fast"})`) return { mode: "resume" };
		if (choice === "Implement directly") return { mode: "direct" };
		if (choice === "Implement with sub-agents (fast)") return { mode: "subagents", workflowMode: "fast" };
		if (choice === "Implement with sub-agents (strict)") return { mode: "subagents", workflowMode: "strict" };
		return null;
	}


	function surfaceWorkflowWarning(ctx: ExtensionContext, message: string): void {
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
			pi.sendMessage(
				{
					customType: "guided-discovery-warning",
					content: message,
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		}
		console.error(message);
	}

	async function maybeSaveFinalPlan(planText: string, ctx: ExtensionContext): Promise<boolean> {
		if (!isFinalPlanResponse(planText)) return false;

		const renderedPlan = renderPlanDocument(planText, researchSources);
		const signature = hashText(renderedPlan);
		if (signature === lastSavedPlanSignature) return false;

		try {
			const workspace = await ensureDiscoveryWorkspace(ctx);
			const planPath = getDiscoveryPlanPath(workspace);
			await writeFile(planPath, renderedPlan, "utf8");
			lastSavedPlanSignature = signature;
			lastSavedPlanDocument = renderedPlan;
			updateUi(ctx);
			persistState();
			if (ctx.hasUI) ctx.ui.notify(`Saved final plan to ${displayPath(planPath)}`, "success");
			return true;
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Failed to save ${PLAN_FILE} in the discovery workspace: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return false;
		}
	}

	async function runSubagentImplementation(
		ctx: ExtensionContext,
		options: {
			planPath?: string;
			rawPrompt?: string;
			extraInstructions: string;
			workflowMode: SubagentWorkflowMode;
			cleanupPlanOnSuccess?: boolean;
			resumeState?: ResumableImplementationState;
		},
	): Promise<boolean> {
		const progressIntro = options.resumeState
			? [
				`Resuming the preserved ${options.resumeState.workflowMode} sub-agent workspace.`,
				`Workspace: ${displayPath(getResumableImplementationWorkflowCwd(options.resumeState))}`,
			]
			: options.rawPrompt?.trim()
				? ["Synthesizing a lightweight plan from the provided request."]
				: [`Using ${options.planPath ? displayPath(options.planPath) : PLAN_FILE} as the approved source of truth.`];
		const runUsageTotals = emptySubagentUsageTotals();
		subagentWorkflowActive = true;
		if (ctx.hasUI) syncUsageFooter(ctx);
		let implementationProgress = createImplementationProgressState({
			detailLines: [...progressIntro, `Workflow mode: ${options.workflowMode}`],
			context: {
				note: options.rawPrompt?.trim()
					? `Standalone ${options.workflowMode} sub-agent implementation workflow starting`
					: `${options.workflowMode} sub-agent implementation workflow starting`,
			},
		});
		let latestImplementationWidgetInput: { stage: string; fallbackLines: string[] } | null = null;
		let lastPrintedProgress: string | null = null;
		const handleImplementationProgress = (update: WorkflowProgressUpdate): void => {
			latestImplementationWidgetInput = { stage: update.stage, fallbackLines: update.lines };
			implementationProgress = reduceImplementationProgress(implementationProgress, update);
			if (ctx.hasUI) {
				setImplementationProgress(ctx, update.stage, implementationProgress, update.lines);
				return;
			}
			const signature = `${update.stage}\n${update.lines.join("\n")}`;
			if (signature === lastPrintedProgress) return;
			lastPrintedProgress = signature;
			const [headline, ...rest] = update.lines;
			console.error(`[guided-implementation:${summarizeImplementationStage(update.stage)}] ${headline ?? update.stage}`);
			for (const line of rest) console.error(`  ${line}`);
		};

		const handleImplementationUsage = function (usage: SubagentUsageTotals): void {
			subagentUsageTotals = addSubagentUsageTotals(subagentUsageTotals, usage);
			runUsageTotals.input += usage.input;
			runUsageTotals.output += usage.output;
			runUsageTotals.cacheRead += usage.cacheRead;
			runUsageTotals.cacheWrite += usage.cacheWrite;
			runUsageTotals.totalTokens += usage.totalTokens;
			runUsageTotals.cost += usage.cost;
			runUsageTotals.turns += usage.turns;
			if (ctx.hasUI) {
				syncUsageFooter(ctx);
				if (latestImplementationWidgetInput) {
					setImplementationProgress(
						ctx,
						latestImplementationWidgetInput.stage,
						implementationProgress,
						latestImplementationWidgetInput.fallbackLines,
					);
				}
			}
		};

		if (ctx.hasUI) {
			latestImplementationWidgetInput = {
				stage: "starting",
				fallbackLines: [...progressIntro, `Workflow mode: ${options.workflowMode}`],
			};
			setImplementationProgress(ctx, "starting", implementationProgress, latestImplementationWidgetInput.fallbackLines);
		}
		const previousResumableState = resumableImplementationState;
		try {
			const result = await runGuidedDiscoveryImplementationWorkflow(pi, ctx, {
				planPath: options.planPath,
				rawPrompt: options.rawPrompt,
				extraInstructions: options.extraInstructions,
				workflowMode: options.workflowMode,
				resumeState: options.resumeState,
				onUpdate: handleImplementationProgress,
				onUsage: handleImplementationUsage,
			});

			if (ctx.hasUI) {
				if (result.decision === "stopped") {
					ctx.ui.notify(
						result.resumableState
							? `Sub-agent implementation stopped with hard blockers still remaining. Resume later with /implement-subagents-resume from ${displayPath(getResumableImplementationWorkflowCwd(result.resumableState))}.`
							: "Sub-agent implementation stopped with hard blockers still remaining. Review the summary to decide whether to continue.",
						"warning",
					);
				}
				pi.sendMessage(
					{
						customType:
							result.decision === "stopped"
								? "guided-discovery-implementation-stopped"
								: "guided-discovery-implementation",
						content: result.summary,
						display: true,
					},
					{ triggerTurn: false },
				);
			} else if (result.summary.trim()) {
				console.log(result.summary.trim());
				if (isPrintModeProcess()) {
					setImmediate(() => process.exit(0));
				}
			}

			if (result.decision === "stopped") {
				await replaceResumableImplementationState(ctx, result.resumableState ?? null, {
					cleanupPrevious: true,
					previousState: previousResumableState,
				});
			}
			if (result.decision === "done") {
				if (previousResumableState && !options.resumeState) {
					await replaceResumableImplementationState(ctx, null, {
						cleanupPrevious: true,
						previousState: previousResumableState,
					});
				} else if (options.resumeState) {
					await replaceResumableImplementationState(ctx, null, {
						cleanupPrevious: false,
						previousState: previousResumableState,
					});
				}
			}

			if (result.decision === "done" && options.cleanupPlanOnSuccess) {
				await cleanupDiscoveryWorkspace(ctx, { clearSavedPlan: true, cleanupOriginalPlanFile: true });
			}
			if (result.decision === "reformulate" && result.reformulationPrompt) {
				await enableDiscovery(ctx);
				pi.sendUserMessage(result.reformulationPrompt);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (options.resumeState && /no longer exists/i.test(message)) {
				await replaceResumableImplementationState(ctx, null, {
					cleanupPrevious: false,
					previousState: options.resumeState,
				});
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`Sub-agent implementation failed: ${message}`, "error");
				pi.sendMessage(
					{
						customType: "guided-discovery-implementation-error",
						content: `Sub-agent implementation failed: ${message}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			} else {
				console.error(`Sub-agent implementation failed: ${message}`);
				if (isPrintModeProcess()) {
					setImmediate(() => process.exit(1));
				}
			}
			return false;
		} finally {
			subagentWorkflowActive = false;
			if (hasUsageTotals(runUsageTotals)) persistState();
			if (ctx.hasUI) {
				syncUsageFooter(ctx);
				clearImplementationProgress(ctx);
			}
		}
	}

	async function resumeSubagentImplementation(ctx: ExtensionContext, extraInstructions: string): Promise<boolean> {
		if (!resumableImplementationState) {
			surfaceWorkflowWarning(ctx, "No resumable sub-agent workspace is available right now.");
			return false;
		}
		return await runSubagentImplementation(ctx, {
			extraInstructions: extraInstructions.trim() || resumableImplementationState.extraInstructions,
			workflowMode: resumableImplementationState.workflowMode,
			resumeState: resumableImplementationState,
		});
	}

	async function startImplementation(
		ctx: ExtensionContext,
		rawArgs: string,
		options?: { skipConfirmation?: boolean; mode?: ImplementationMode; workflowMode?: SubagentWorkflowMode },
	): Promise<boolean> {
		const request = parseImplementationRequest(rawArgs);
		if ((options?.mode && options.mode !== "direct") || request.mode === "subagents") {
			surfaceWorkflowWarning(
				ctx,
				"Sub-agent implementation has been removed. Proceeding with straight-line implementation in the main session instead.",
			);
		}
		const planSource = await getApprovedPlanSource(ctx);

		if (!options?.skipConfirmation && ctx.hasUI) {
			const summary = planSource.hasPlan
				? `Latest approved plan saved to ${planSource.displayPath}.${researchSources.length > 0 ? ` External sources captured: ${researchSources.length}.` : ""}`
				: `No approved ${PLAN_FILE} was detected yet. Implementation will rely on the conversation history.`;
			const approved = await ctx.ui.confirm("Implement now?", summary);
			if (!approved) return false;
		}

		if (enabled) await disableDiscovery(ctx);

		const inlinePlanText =
			planSource.hasPlan && planSource.source === "workspace"
				? await readFile(planSource.path, "utf8").catch(() => lastSavedPlanDocument ?? undefined)
				: undefined;
		const prompt = buildImplementationPrompt({
			extraInstructions: request.extraInstructions,
			planPath: planSource.hasPlan && planSource.source === "cwd" ? planSource.path : undefined,
			inlinePlanText,
		});
		if (planSource.hasPlan && planSource.source === "workspace") {
			await cleanupDiscoveryWorkspace(ctx, { clearSavedPlan: true, cleanupOriginalPlanFile: true });
		}
		directImplementationKickoffPending = true;
		pi.sendUserMessage(prompt);
		return true;
	}

	async function promptForPlanApproval(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const planSource = await getApprovedPlanSource(ctx);
		const choice = await ctx.ui.select(
			`Final plan saved to ${planSource.hasPlan ? planSource.displayPath : PLAN_FILE}. Implement or not implement?`,
			["Implement now", "Do not implement", "Keep refining in discovery mode"],
		);

		if (choice === "Implement now") {
			await startImplementation(ctx, "", { skipConfirmation: true, mode: "direct" });
			return;
		}

		if (choice === "Do not implement") {
			await disableDiscovery(ctx);
			ctx.ui.notify("Discovery mode disabled. The saved plan remains available if you want to implement it later.", "info");
		}
	}

	pi.registerFlag("discover", {
		description: "Start in guided discovery mode",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("discover", {
		description: "Enable guided discovery mode and optionally start with a loose feature prompt",
		handler: async (args, ctx) => {
			if (!enabled) {
				await enableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode enabled", "success");
			}

			const goal = args.trim();
			if (!goal) return;

			await resetDiscoveryProgress(ctx);
			persistState();
			updateUi(ctx);

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the agent is idle before starting a new discovery prompt", "warning");
				return;
			}

			pi.sendUserMessage(kickoffPrompt(goal));
		},
	});

	pi.registerCommand("discover-off", {
		description: "Disable guided discovery mode and restore normal tools",
		handler: async (_args, ctx) => {
			if (!enabled) {
				ctx.ui.notify("Guided discovery mode is already off", "info");
				return;
			}
			await disableDiscovery(ctx);
			ctx.ui.notify("Guided discovery mode disabled", "success");
		},
	});

	pi.registerCommand("discover-implement", {
		description: "Exit guided discovery mode and start implementing the agreed plan in the main session",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the agent is idle before switching to implementation", "warning");
				return;
			}

			await startImplementation(ctx, args.trim());
		},
	});


	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle guided discovery mode",
		handler: async (ctx) => {
			if (enabled) {
				await disableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode disabled", "success");
			} else {
				await enableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode enabled", "success");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		const workspace = discoveryWorkspace ?? (await ensureDiscoveryWorkspace(ctx).catch(() => null));
		const workspaceNote = workspace
			? `\n\n[Guided discovery workspace]\nOperate against the isolated discovery workspace at ${getDiscoveryWorkflowCwd(workspace)}. Relative repo paths and read-only bash commands are routed there automatically. Save the approved PLAN.md there, not in the original checkout.`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n${DISCOVERY_PROMPT_APPEND}${workspaceNote}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) {
			if (!directImplementationKickoffPending) return;
			if (event.toolName === "questionnaire" && isRedundantImplementationKickoffQuestionnaire(event.input)) {
				return {
					block: true,
					reason:
						"Implementation was already approved. Do not ask the user whether to proceed or whether to use the approved plan again. Start implementing, and reserve questionnaire for real blocking ambiguities or post-review fix/defer choices.",
				};
			}
			if (event.toolName !== "questionnaire") directImplementationKickoffPending = false;
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Guided discovery mode is read-only. Use /discover-implement or /discover-off to start coding.",
			};
		}

		const workspace = await ensureDiscoveryWorkspace(ctx).catch((error) => {
			return error instanceof Error ? error.message : String(error);
		});
		if (typeof workspace === "string") {
			return {
				block: true,
				reason: `Guided discovery could not prepare its isolated workspace: ${workspace}`,
			};
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: "Guided discovery mode only allows read-only bash commands. Use /discover-implement or /discover-off to start coding.",
				};
			}
			event.input.command = `cd ${shellQuote(getDiscoveryWorkflowCwd(workspace))} && ${command}`;
			return;
		}

		if (event.toolName === "read" && typeof event.input.path === "string") {
			event.input.path = mapPathIntoDiscoveryWorkspace(event.input.path, workspace);
			return;
		}

		if ((event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") && event.input) {
			const currentPath = typeof event.input.path === "string" && event.input.path.trim() ? event.input.path : ".";
			event.input.path = mapPathIntoDiscoveryWorkspace(currentPath, workspace);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "questionnaire") {
			const details = event.details as { cancelled?: boolean; answers?: unknown[] } | undefined;
			if (!details?.cancelled && Array.isArray(details?.answers) && details.answers.length > 0) {
				questionnaireBatchCount += 1;
				updateUi(ctx);
				persistState();
			}
			return;
		}
		if (event.toolName !== "web_research") return;
		const details = event.details as { sources?: ResearchSource[] } | undefined;
		if (!Array.isArray(details?.sources) || details.sources.length === 0) return;
		researchSources = mergeResearchSources(researchSources, details.sources);
		updateUi(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) {
			directImplementationKickoffPending = false;
			return;
		}
		const assistantText = getLastAssistantText(event.messages as AgentMessage[]);
		if (!assistantText) return;
		const saved = await maybeSaveFinalPlan(assistantText, ctx);
		if (saved) {
			if (questionnaireBatchCount === 0) {
				lastSavedPlanSignature = null;
				persistState();
				updateUi(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify("Before approval, guided discovery must ask at least one clarifying questionnaire batch.", "warning");
				}
				pi.sendUserMessage(
					"Before finalizing, ask me a focused questionnaire batch that gets to the real point of the idea, uncovers likely side effects, and flushes out the key decisions that would materially change implementation. After I answer, update the plan and present the final plan again.",
				);
				return;
			}
			await promptForPlanApproval(ctx);
			return;
		}
		updateUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (enabled || lastSavedPlanSignature || lastSavedPlanDocument) return;
		if (!discoveryWorkspace && !discoveryWorkspaceState) return;
		await cleanupDiscoveryWorkspace(ctx, { clearSavedPlan: false, cleanupOriginalPlanFile: false });
	});

	pi.on("session_start", async (_event, ctx) => {
		directImplementationKickoffPending = false;
		const branchEntries = ctx.sessionManager.getBranch() as Array<{
			type: string;
			customType?: string;
			data?: SavedState;
			message?: unknown;
		}>;
		const savedEntry = branchEntries.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).pop();
		const savedState = savedEntry?.data;

		enabled = savedState?.enabled === true || pi.getFlag("discover") === true;
		previousActiveTools = normalizeToolList(savedState?.previousActiveTools) ?? previousActiveTools;
		lastSavedPlanSignature = savedState?.lastSavedPlanSignature ?? null;
		lastSavedPlanDocument = savedState?.lastSavedPlanDocument ?? null;
		researchSources = mergeResearchSources(savedState?.researchSources ?? [], extractResearchSourcesFromEntries(branchEntries));
		questionnaireBatchCount = savedState?.questionnaireBatchCount ?? 0;
		subagentUsageTotals = emptySubagentUsageTotals();
		discoveryWorkspaceState = savedState?.discoveryWorkspace ?? null;
		discoveryWorkspace = null;
		resumableImplementationState = null;
		if (savedState?.resumableImplementation) {
			await cleanupResumableImplementationWorkspace(savedState.resumableImplementation).catch(() => {});
		}

		if (enabled) {
			applyDiscoveryTools();
			await ensureDiscoveryWorkspace(ctx).catch(() => {});
		}
		updateUi(ctx);
	});
}
