import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
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
You are in a planning-first workflow that turns loose ideas into an implementation-ready plan.

Your job in this mode:
1. Research the repository first using read-only tools. Inspect the existing code, conventions, architecture, tests, and docs before proposing implementation details.
2. When external knowledge materially matters, use web_research for official docs, vendor docs, API references, competitor/market context, and current best practices.
3. Infer the real decision tree. Look for product/business decisions, UX choices, data model and API decisions, migration concerns, rollout constraints, testing strategy, and non-functional requirements.
4. Ask clarifying questions with the questionnaire tool whenever an unresolved decision materially affects the plan.
5. Prefer 1-4 focused questions per batch, mostly multiple choice. Options should be concrete, mutually useful, and include likely defaults. Keep allowOther enabled unless a free-form answer would be harmful.
6. Prefer first-party sources when doing external research. Summarize what the sources imply instead of dumping raw excerpts.
7. Balance state-of-the-art practice with simplicity and robustness. Do not recommend fashionable complexity when a simpler proven approach fits the problem.
8. After each answer batch, briefly summarize what changed, what remains uncertain, and whether more research is needed.
9. Avoid unnecessary questions. If the repository or common practice strongly suggests a good default, recommend it explicitly instead of asking for permission on every minor choice.
10. Focus on creating a plan that is as simple and robust as possible.
11. Do not implement or modify files while this mode is active.
12. Once the plan is implementation-ready, respond with these exact sections:
    ## Problem
    ## What I learned
    ## Decision log
    ## Recommended approach
    ## Implementation plan
    ## Acceptance criteria
    ## Risks / follow-ups
13. If the user clearly wants to start coding, tell them to run /discover-implement, /implement-subagents, or /discover-off first.
`;

interface SavedState {
	enabled?: boolean;
	previousActiveTools?: string[] | null;
	lastSavedPlanSignature?: string | null;
	researchSources?: ResearchSource[] | null;
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

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, {
			enabled,
			previousActiveTools,
			lastSavedPlanSignature,
			researchSources,
		} satisfies SavedState);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const lines = [
			ctx.ui.theme.fg("accent", "Guided discovery mode active"),
			ctx.ui.theme.fg(
				"dim",
				"Read-only repo + web research • structured questions • PLAN.md auto-saves • /discover-implement or /implement-subagents to start coding",
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
			"Research the codebase first.",
			"If external docs, API details, competitor patterns, or market context matter, use web_research after you understand the repository.",
			"Then identify the key decisions and trade-offs, and ask the first batch of clarifying questions with the questionnaire tool.",
		].join("\n");
	}

	function supportsStructuredImplementationWidget(ctx: ExtensionContext): boolean {
		return ctx.hasUI;
	}

	function summarizeImplementationStage(stage: string): string {
		const [baseStage] = stage.split(":");
		switch (baseStage) {
			case "starting":
			case "decomposer":
			case "worker":
			case "checker":
			case "fix":
			case "validator":
			case "finish":
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

		if (ctx.hasUI) {
			setImplementationProgress(ctx, "starting", implementationProgress, progressIntro);
		}
		try {
			const result = await runGuidedDiscoveryImplementationWorkflow(pi, ctx, {
				planPath: options.planPath,
				rawPrompt: options.rawPrompt,
				extraInstructions: options.extraInstructions,
				onUpdate: handleImplementationProgress,
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
			if (ctx.hasUI) clearImplementationProgress(ctx);
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

		if (enabled) {
			applyDiscoveryTools();
		}
		updateUi(ctx);
	});
}
