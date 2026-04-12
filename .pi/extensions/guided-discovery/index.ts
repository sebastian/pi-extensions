import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { padToWidth, truncateToWidth, visibleWidth } from "./tui-compat.ts";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	parseImplementationRequest,
	resolveStandaloneSubagentRequest,
	runGuidedDiscoveryImplementationWorkflow,
	type ImplementationMode,
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
import {
	type ResearchSource,
	hashText,
	isFinalPlanResponse,
	isSafeCommand,
	mergeResearchSources,
	renderPlanDocument,
} from "./utils.ts";
import registerWebResearch from "./web-research.ts";

const DISCOVERY_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "web_research"];
const DEFAULT_IMPLEMENTATION_TOOLS = ["read", "bash", "edit", "write"];
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
5. Ask clarifying questions only when a missing answer would materially change what should be built. Usually ask at most one focused batch at a time, and often ask none.
6. Keep interim summaries short. Do not narrate every micro-step of planning or research.
7. For remote websites and product references, prefer web_research over ad-hoc scraping.
8. Favor simple, proven approaches over elaborate agent-generated architecture.
9. Do not implement or modify files while this mode is active.
10. Once the plan is implementation-ready, respond with these exact sections:
    ## Problem
    ## Key findings
    ## Options and trade-offs
    ## Recommended approach
    ## Build plan
    ## Acceptance checks
    ## Risks / follow-ups
11. If the user clearly wants to start coding, tell them to run /discover-implement, /implement-subagents, or /discover-off first.
`;

interface SavedState {
	enabled?: boolean;
	previousActiveTools?: string[] | null;
	lastSavedPlanSignature?: string | null;
	researchSources?: ResearchSource[] | null;
	subagentUsageTotals?: SubagentUsageTotals | null;
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

function hasSubagentUsageTotals(usage: SubagentUsageTotals): boolean {
	return Boolean(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost || usage.turns);
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return (count / 1000).toFixed(1) + "k";
	if (count < 1000000) return Math.round(count / 1000) + "k";
	if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
	return Math.round(count / 1000000) + "M";
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

export default function guidedDiscovery(pi: ExtensionAPI): void {
	registerQuestionnaire(pi);
	registerWebResearch(pi);

	let enabled = false;
	let previousActiveTools: string[] | null = null;
	let researchSources: ResearchSource[] = [];
	let lastSavedPlanSignature: string | null = null;
	let subagentUsageTotals = emptySubagentUsageTotals();
	let subagentWorkflowActive = false;
	let ownsFooter = false;

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, {
			enabled,
			previousActiveTools,
			lastSavedPlanSignature,
			researchSources,
			subagentUsageTotals,
		} satisfies SavedState);
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

	function sanitizeFooterText(text: string): string {
	const controlChars = [String.fromCharCode(13), String.fromCharCode(10), String.fromCharCode(9)];
	let value = text;
	for (const controlChar of controlChars) value = value.split(controlChar).join(" ");
	return value.replace(/ +/g, " ").trim();
}

function syncUsageFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!subagentWorkflowActive && !hasSubagentUsageTotals(subagentUsageTotals)) {
			if (ownsFooter) {
				ctx.ui.setFooter(undefined);
				ownsFooter = false;
			}
			return;
		}

		ctx.ui.setFooter(function (tui, theme, footerData) {
			const dispose = footerData.onBranchChange(function () {
				tui.requestRender();
			});

			return {
				dispose,
				invalidate() {},
				render(width: number): string[] {
					const sessionUsage = collectSessionAssistantUsage(ctx);
					const totalUsage = addSubagentUsageTotals(sessionUsage, subagentUsageTotals);
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
					const branch = footerData.getGitBranch();
					if (branch) pwd += " (" + branch + ")";
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += " • " + sessionName;

					const statsParts: string[] = [];
					if (totalUsage.input) statsParts.push("↑" + formatTokens(totalUsage.input));
					if (totalUsage.output) statsParts.push("↓" + formatTokens(totalUsage.output));
					if (totalUsage.cacheRead) statsParts.push("R" + formatTokens(totalUsage.cacheRead));
					if (totalUsage.cacheWrite) statsParts.push("W" + formatTokens(totalUsage.cacheWrite));
					if (totalUsage.cost || hasSubagentUsageTotals(subagentUsageTotals)) {
						let costPart = "$" + totalUsage.cost.toFixed(3);
						if (hasSubagentUsageTotals(subagentUsageTotals)) costPart += " +subagents";
						statsParts.push(costPart);
					}

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
					return lines;
				}
			};
		});
		ownsFooter = true;
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			syncUsageFooter(ctx);
			return;
		}

		const lines = [
			ctx.ui.theme.fg("accent", "Guided discovery mode active"),
			ctx.ui.theme.fg(
				"dim",
				"Read-only repo + active web research • focused trade-offs • concise PLAN.md • /discover-implement or /implement-subagents to start coding",
			),
		];

		if (researchSources.length > 0) {
			lines.push(ctx.ui.theme.fg("muted", `Captured external sources: ${researchSources.length}`));
		}
		if (lastSavedPlanSignature) {
			lines.push(ctx.ui.theme.fg("success", "Latest final plan saved to PLAN.md"));
		}

		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "🧭 discover"));
		ctx.ui.setWidget(WIDGET_KEY, lines);
		syncUsageFooter(ctx);
	}

	function applyDiscoveryTools(): void {
		pi.setActiveTools(DISCOVERY_MODE_TOOLS);
	}

	function restoreTools(): void {
		pi.setActiveTools(normalizeToolList(previousActiveTools) ?? DEFAULT_IMPLEMENTATION_TOOLS);
	}

	function enableDiscovery(ctx: ExtensionContext): void {
		if (!enabled) {
			previousActiveTools = normalizeToolList(pi.getActiveTools().map((tool) => tool.name));
		}
		enabled = true;
		applyDiscoveryTools();
		updateUi(ctx);
		persistState();
	}

	function disableDiscovery(ctx: ExtensionContext): void {
		enabled = false;
		restoreTools();
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
			"Make concrete recommendations, keep the plan concise, and ask only the highest-leverage questions if something truly blocks a good decision.",
		].join("\n");
	}

	function supportsStructuredImplementationWidget(ctx: ExtensionContext): boolean {
		return ctx.hasUI;
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
		ctx.ui.setStatus(
			STATUS_KEY,
			state.failure
				? ctx.ui.theme.fg("error", "🤖 failed")
				: state.finished
					? ctx.ui.theme.fg("success", "🤖 complete")
					: ctx.ui.theme.fg("accent", `🤖 ${stageLabel}`),
		);

		if (supportsStructuredImplementationWidget(ctx)) {
			ctx.ui.setWidget(WIDGET_KEY, createImplementationProgressWidget(() => state), { placement: "aboveEditor" });
			return;
		}

		const detailLines = state.detailLines.length > 0 ? state.detailLines : fallbackLines;
		ctx.ui.setWidget(
			WIDGET_KEY,
			[
				ctx.ui.theme.fg("accent", `Guided implementation • ${stageLabel}`),
				...detailLines.map((line) => ctx.ui.theme.fg("dim", line)),
			],
			{ placement: "aboveEditor" },
		);
	}

	function clearImplementationProgress(ctx: ExtensionContext): void {
		if (enabled) updateUi(ctx);
		else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	async function chooseImplementationMode(ctx: ExtensionContext, hasPlanFile: boolean): Promise<ImplementationMode | null> {
		if (!ctx.hasUI) return null;
		if (!hasPlanFile) {
			const choice = await ctx.ui.select(
				`No ${PLAN_FILE} detected. Direct mode will rely on the conversation history. Use /implement-subagents with a raw prompt if you want the isolated sub-agent workflow instead.`,
				["Implement directly", "Cancel"],
			);
			return choice === "Implement directly" ? "direct" : null;
		}
		const choice = await ctx.ui.select(`Latest approved plan saved to ${PLAN_FILE}. Choose an implementation mode.`, [
			"Implement directly",
			"Implement with sub-agents",
			"Cancel",
		]);
		if (choice === "Implement directly") return "direct";
		if (choice === "Implement with sub-agents") return "subagents";
		return null;
	}

	function buildImplementationPrompt(extraInstructions: string, hasPlanFile: boolean): string {
		const instructions = [
			"Implement the approved plan from this session.",
			hasPlanFile
				? `Use ${PLAN_FILE} as the source of truth for the latest approved plan.`
				: "Use the approved conversation context from this session as the source of truth; no PLAN.md file is available yet.",
			"Follow the decision log and recommended approach established during discovery.",
			"If anything still feels ambiguous and high-risk, ask before making the change.",
		];
		if (extraInstructions.trim()) {
			instructions.push(`Additional instructions: ${extraInstructions.trim()}`);
		}
		return instructions.join(" ");
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
			await writeFile(resolve(ctx.cwd, PLAN_FILE), renderedPlan, "utf8");
			lastSavedPlanSignature = signature;
			updateUi(ctx);
			persistState();
			if (ctx.hasUI) ctx.ui.notify(`Saved final plan to ${PLAN_FILE}`, "success");
			return true;
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Failed to save ${PLAN_FILE}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return false;
		}
	}

	async function runSubagentImplementation(
		ctx: ExtensionContext,
		options: { planPath?: string; rawPrompt?: string; extraInstructions: string },
	): Promise<boolean> {
		const progressIntro = options.rawPrompt?.trim()
			? ["Synthesizing a lightweight plan from the provided request."]
			: [`Using ${PLAN_FILE} as the approved source of truth.`];
		const runUsageTotals = emptySubagentUsageTotals();
		subagentWorkflowActive = true;
		if (ctx.hasUI) syncUsageFooter(ctx);
		let implementationProgress = createImplementationProgressState({
			detailLines: progressIntro,
			context: {
				note: options.rawPrompt?.trim()
					? "Standalone sub-agent implementation workflow starting"
					: "Sub-agent implementation workflow starting",
			},
		});
		let lastPrintedProgress: string | null = null;
		const handleImplementationProgress = (update: WorkflowProgressUpdate): void => {
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
			if (ctx.hasUI) syncUsageFooter(ctx);
		};

		if (ctx.hasUI) {
			setImplementationProgress(ctx, "starting", implementationProgress, progressIntro);
		}
		try {
			const result = await runGuidedDiscoveryImplementationWorkflow(pi, ctx, {
				planPath: options.planPath,
				rawPrompt: options.rawPrompt,
				extraInstructions: options.extraInstructions,
				onUpdate: handleImplementationProgress,
			onUsage: handleImplementationUsage,
			});

			if (ctx.hasUI) {
				pi.sendMessage(
					{
						customType: "guided-discovery-implementation",
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

			if (result.decision === "reformulate" && result.reformulationPrompt) {
				enableDiscovery(ctx);
				pi.sendUserMessage(result.reformulationPrompt);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
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
			if (hasSubagentUsageTotals(runUsageTotals)) persistState();
			if (ctx.hasUI) {
				syncUsageFooter(ctx);
				clearImplementationProgress(ctx);
			}
		}
	}

	async function startImplementation(
		ctx: ExtensionContext,
		rawArgs: string,
		options?: { skipConfirmation?: boolean; mode?: ImplementationMode },
	): Promise<boolean> {
		const request = parseImplementationRequest(rawArgs);
		const planPath = resolve(ctx.cwd, PLAN_FILE);
		const hasPlanFile = await fileExists(planPath);
		let mode = options?.mode ?? request.mode;

		if (!mode && ctx.hasUI) {
			mode = await chooseImplementationMode(ctx, hasPlanFile);
			if (!mode) return false;
			options = { ...options, skipConfirmation: true };
		}
		if (!mode) mode = "direct";

		if (mode === "subagents" && !hasPlanFile) {
			surfaceWorkflowWarning(
				ctx,
				`Sub-agent mode requires an approved ${PLAN_FILE}. Use /implement-subagents with a raw prompt, or create PLAN.md first.`,
			);
			return false;
		}

		if (mode === "direct" && !options?.skipConfirmation && ctx.hasUI) {
			const summary = hasPlanFile
				? `Latest approved plan saved to ${PLAN_FILE}.${researchSources.length > 0 ? ` External sources captured: ${researchSources.length}.` : ""}`
				: `No ${PLAN_FILE} was detected yet. Implementation will rely on the conversation history.`;
			const approved = await ctx.ui.confirm("Start implementing the plan directly?", summary);
			if (!approved) return false;
		}

		if (enabled) disableDiscovery(ctx);

		if (mode === "direct") {
			pi.sendUserMessage(buildImplementationPrompt(request.extraInstructions, hasPlanFile));
			return true;
		}

		return await runSubagentImplementation(ctx, {
			planPath,
			extraInstructions: request.extraInstructions,
		});
	}

	async function promptForPlanApproval(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Final plan saved to PLAN.md. What next?", [
			"Implement directly",
			"Implement with sub-agents",
			"Keep refining in discovery mode",
			"Leave discovery mode with plan only",
		]);

		if (choice === "Implement directly") {
			await startImplementation(ctx, "", { skipConfirmation: true, mode: "direct" });
			return;
		}

		if (choice === "Implement with sub-agents") {
			await startImplementation(ctx, "", { skipConfirmation: true, mode: "subagents" });
			return;
		}

		if (choice === "Leave discovery mode with plan only") {
			disableDiscovery(ctx);
			ctx.ui.notify("Discovery mode disabled. PLAN.md kept as the latest approved plan.", "info");
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
				enableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode enabled", "success");
			}

			const goal = args.trim();
			if (!goal) return;

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
			disableDiscovery(ctx);
			ctx.ui.notify("Guided discovery mode disabled", "success");
		},
	});

	pi.registerCommand("discover-implement", {
		description: "Exit guided discovery mode and start implementing the agreed plan",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the agent is idle before switching to implementation", "warning");
				return;
			}

			await startImplementation(ctx, args.trim());
		},
	});

	pi.registerCommand("implement-subagents", {
		description: "Run the standalone sub-agent implementation workflow from PLAN.md or a raw prompt",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait until the agent is idle before starting sub-agent implementation", "warning");
				return;
			}

			const planPath = resolve(ctx.cwd, PLAN_FILE);
			const request = resolveStandaloneSubagentRequest({
				rawArgs: args,
				planPath,
				hasPlanFile: await fileExists(planPath),
			});

			if (request.kind === "missing-plan") {
				surfaceWorkflowWarning(ctx, request.message);
				return;
			}
			if (enabled) disableDiscovery(ctx);

			await runSubagentImplementation(ctx, {
				extraInstructions: "",
				...(request.kind === "raw-prompt" ? { rawPrompt: request.rawPrompt } : { planPath: request.planPath }),
			});
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle guided discovery mode",
		handler: async (ctx) => {
			if (enabled) {
				disableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode disabled", "success");
			} else {
				enableDiscovery(ctx);
				ctx.ui.notify("Guided discovery mode enabled", "success");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n${DISCOVERY_PROMPT_APPEND}`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Guided discovery mode is read-only. Use /discover-implement, /implement-subagents, or /discover-off to start coding.",
			};
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason:
						"Guided discovery mode only allows read-only bash commands. Use /discover-implement, /implement-subagents, or /discover-off to start coding.",
				};
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "web_research") return;
		const details = event.details as { sources?: ResearchSource[] } | undefined;
		if (!Array.isArray(details?.sources) || details.sources.length === 0) return;
		researchSources = mergeResearchSources(researchSources, details.sources);
		updateUi(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) return;
		const assistantText = getLastAssistantText(event.messages as AgentMessage[]);
		if (!assistantText) return;
		const saved = await maybeSaveFinalPlan(assistantText, ctx);
		if (saved) {
			await promptForPlanApproval(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
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
		researchSources = mergeResearchSources(savedState?.researchSources ?? [], extractResearchSourcesFromEntries(branchEntries));
		subagentUsageTotals = savedState?.subagentUsageTotals ?? emptySubagentUsageTotals();

		if (enabled) {
			applyDiscoveryTools();
		}
		updateUi(ctx);
	});
}
