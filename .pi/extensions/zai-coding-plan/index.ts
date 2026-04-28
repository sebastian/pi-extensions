import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	buildZaiUsageIndicatorLines,
	extractZaiAuthToken,
	getZaiUsageKey,
	getZaiUsageOrigin,
	isZaiUsageModel,
	parseZaiQuotaSnapshot,
} from "./usage-indicator.ts";

export const ZAI_CODING_PLAN_PROVIDER_ID = "zai-coding-plan";
export const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_PLAN_API_KEY_ENV = "ZAI_API_KEY";

const ZAI_USAGE_STATUS_KEY = "zai-usage-indicator";
const ZAI_USAGE_MONITOR_PATH = "/api/monitor/usage/quota/limit";
const ZAI_USAGE_REFRESH_INTERVAL_MS = 90_000;
const ZAI_USAGE_MIN_FETCH_INTERVAL_MS = 20_000;
const ZAI_USAGE_POST_TURN_REFRESH_DELAY_MS = 2_000;
const ZAI_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const FOOTER_MIN_GAP = 2;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

const ZAI_COMPAT = {
	supportsDeveloperRole: false,
	thinkingFormat: "zai",
} as const;

const ZAI_TOOL_STREAM_COMPAT = {
	...ZAI_COMPAT,
	zaiToolStream: true,
} as const;

const GLM_51_REIN_IN_PROMPT = [
	"- Be concise, direct, and matter-of-fact.",
	"- Do not be flattering, sycophantic, or overly eager to please.",
	"- Avoid unnecessary praise, reassurance, or agreement.",
	"- Keep preambles short and skip filler.",
	"- State uncertainty briefly when needed, then continue with the best grounded answer.",
].join("\n");

// Use a conservative effective window for GLM-5.1 so pi compacts near ~100k prompt
// tokens with the default reserve instead of waiting for the model's advertised limit.
const GLM_51_EFFECTIVE_CONTEXT_WINDOW = 116_384;

export const ZAI_CODING_PLAN_MODELS = [
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: GLM_51_EFFECTIVE_CONTEXT_WINDOW,
		maxTokens: 131072,
		compat: ZAI_TOOL_STREAM_COMPAT,
	},
	{
		id: "glm-5-turbo",
		name: "GLM-5-Turbo",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200000,
		maxTokens: 131072,
		compat: ZAI_TOOL_STREAM_COMPAT,
	},
	{
		id: "glm-5",
		name: "GLM-5",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 204800,
		maxTokens: 131072,
		compat: ZAI_TOOL_STREAM_COMPAT,
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 204800,
		maxTokens: 131072,
		compat: ZAI_TOOL_STREAM_COMPAT,
	},
	{
		id: "glm-4.5-air",
		name: "GLM-4.5-Air",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131072,
		maxTokens: 98304,
		compat: ZAI_COMPAT,
	},
] as const;

interface UsageTrackerState {
	active: boolean;
	activeKey: string | null;
	snapshot: ReturnType<typeof parseZaiQuotaSnapshot> | null;
	loading: boolean;
	error: string | null;
	lastFetchStartedAt: number;
	inFlight: Promise<void> | null;
	inFlightKey: string | null;
	intervalHandle: ReturnType<typeof setInterval> | null;
	deferredHandle: ReturnType<typeof setTimeout> | null;
	lastStatusSignature: string | null;
}

function cloneModels() {
	return ZAI_CODING_PLAN_MODELS.map((model) => ({
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		compat: { ...model.compat },
	}));
}

export function registerZaiCodingPlan(
	pi: Pick<ExtensionAPI, "registerProvider">,
): void {
	pi.registerProvider(ZAI_CODING_PLAN_PROVIDER_ID, {
		baseUrl: ZAI_CODING_PLAN_BASE_URL,
		apiKey: ZAI_CODING_PLAN_API_KEY_ENV,
		api: "openai-completions",
		models: cloneModels(),
	});
}

interface RepoLocation {
	root: string;
	kind: "jj" | "git";
}

interface JjRepoMetadata {
	changeId: string;
	commitId: string;
	description: string;
}

type ExecLike = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const JJ_REPO_METADATA_TEMPLATE = 'change_id.short(8) ++ "\\n" ++ commit_id.short(8) ++ "\\n" ++ description.first_line()';

function findRepoLocation(start: string): RepoLocation | null {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".jj"))) return { root: current, kind: "jj" };
		if (existsSync(join(current, ".git"))) return { root: current, kind: "git" };
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function parseJjRepoMetadata(output: string): JjRepoMetadata | null {
	const normalized = output.replace(/\r/g, "").trimEnd();
	if (!normalized.trim()) return null;
	const [rawChangeId = "", rawCommitId = "", ...rawDescription] = normalized.split("\n");
	const changeId = rawChangeId.trim();
	const commitId = rawCommitId.trim();
	if (!changeId || !commitId) return null;
	const description = rawDescription.join("\n").trim() || "(no description)";
	return { changeId, commitId, description };
}

function formatJjRepoMetadata(metadata: JjRepoMetadata): string {
	return `jj ${metadata.changeId} • ${metadata.description || "(no description)"}`;
}

async function readJjRepoMetadata(start: string, exec: ExecLike): Promise<JjRepoMetadata | null> {
	const repo = findRepoLocation(start);
	if (!repo || repo.kind !== "jj") return null;
	const result = await exec("jj", ["log", "-r", "@", "--no-graph", "-T", JJ_REPO_METADATA_TEMPLATE], {
		cwd: repo.root,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `Failed to read jj change metadata at ${repo.root}`);
	}
	return parseJjRepoMetadata(result.stdout);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const plain = stripAnsi(text);
	const ellipsisWidth = Math.min(width, visibleWidth(ellipsis));
	const kept = Math.max(0, width - ellipsisWidth);
	return plain.slice(0, kept) + (ellipsisWidth > 0 ? stripAnsi(ellipsis).slice(0, ellipsisWidth) : "");
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function getCurrentThinkingLevel(ctx: ExtensionContext): string {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
			return entry.thinkingLevel;
		}
	}
	return "off";
}

function buildInlineFooter(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: ExtensionContext["ui"]["theme"],
	width: number,
	repoChromeLabel: string | null,
): string[] {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			totalInput += message.usage.input;
			totalOutput += message.usage.output;
			totalCacheRead += message.usage.cacheRead;
			totalCacheWrite += message.usage.cacheWrite;
			totalCost += message.usage.cost.total;
		}
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = typeof contextUsage?.percent === "number" ? contextPercentValue.toFixed(1) : "?";

	let pwd = ctx.sessionManager.getCwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
	if (repoChromeLabel) pwd = `${pwd} (${repoChromeLabel})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	const dimSep = theme.fg("dim", " ");
	const inlineSep = theme.fg("dim", " · ");
	const leftParts: string[] = [];
	if (totalInput) leftParts.push(theme.fg("dim", `↑${formatTokens(totalInput)}`));
	if (totalOutput) leftParts.push(theme.fg("dim", `↓${formatTokens(totalOutput)}`));
	if (totalCacheRead) leftParts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
	if (totalCacheWrite) leftParts.push(theme.fg("dim", `W${formatTokens(totalCacheWrite)}`));
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) {
		leftParts.push(theme.fg("dim", `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
	}
	const contextPercentDisplay =
		contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
	leftParts.push(
		contextPercentValue > 90
			? theme.fg("error", contextPercentDisplay)
			: contextPercentValue > 70
				? theme.fg("warning", contextPercentDisplay)
				: theme.fg("dim", contextPercentDisplay),
	);

	const extensionStatuses = footerData.getExtensionStatuses();
	const zaiStatus = extensionStatuses.get(ZAI_USAGE_STATUS_KEY);
	if (zaiStatus) leftParts.push(sanitizeStatusText(zaiStatus));
	let left = leftParts.join(dimSep);
	left = truncateToWidth(left, width, theme.fg("dim", "..."));

	const modelName = ctx.model?.id || "no-model";
	let right = modelName;
	if (ctx.model?.reasoning) {
		const thinkingLevel = getCurrentThinkingLevel(ctx);
		right = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const candidate = `(${ctx.model.provider}) ${right}`;
		if (visibleWidth(left) + FOOTER_MIN_GAP + visibleWidth(candidate) <= width) right = candidate;
	}
	const rightColored = theme.fg("dim", right);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(rightColored);
	const totalNeeded = leftWidth + FOOTER_MIN_GAP + rightWidth;
	const statsLine =
		totalNeeded <= width
			? left + " ".repeat(width - leftWidth - rightWidth) + rightColored
			: left;

	const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), statsLine];
	const otherStatuses = Array.from(extensionStatuses.entries())
		.filter(([key]) => key !== ZAI_USAGE_STATUS_KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
	if (otherStatuses.length > 0) {
		lines.push(truncateToWidth(otherStatuses.join(inlineSep), width, theme.fg("dim", "...")));
	}
	return lines;
}

function buildFooterFallbackLines(
	theme: ExtensionContext["ui"]["theme"],
	width: number,
	lastLines?: string[] | null,
): string[] {
	const ellipsis = theme.fg("dim", "...");
	if (lastLines && lastLines.length > 0) {
		return lastLines.map((line) => truncateToWidth(line, width, ellipsis));
	}
	return [truncateToWidth(theme.fg("dim", "z.ai footer unavailable"), width, ellipsis)];
}

function createUsageTracker(syncInlineFooter: (ctx: ExtensionContext) => void) {
	const state: UsageTrackerState = {
		active: false,
		activeKey: null,
		snapshot: null,
		loading: false,
		error: null,
		lastFetchStartedAt: 0,
		inFlight: null,
		inFlightKey: null,
		intervalHandle: null,
		deferredHandle: null,
		lastStatusSignature: null,
	};

	function clearTimers(): void {
		if (state.intervalHandle) {
			clearInterval(state.intervalHandle);
			state.intervalHandle = null;
		}
		if (state.deferredHandle) {
			clearTimeout(state.deferredHandle);
			state.deferredHandle = null;
		}
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(ZAI_USAGE_STATUS_KEY, undefined);
		state.lastStatusSignature = null;
	}

	function resetUsageState(nextKey: string | null): void {
		state.activeKey = nextKey;
		state.snapshot = null;
		state.loading = false;
		state.error = null;
		state.lastFetchStartedAt = 0;
		state.lastStatusSignature = null;
	}

	function syncStatus(ctx: ExtensionContext): void {
		if (!state.active || !ctx.hasUI) return;
		if (!ctx.model || !isZaiUsageModel(ctx.model)) {
			resetUsageState(null);
			clearStatus(ctx);
			return;
		}

		const key = getZaiUsageKey(ctx.model);
		if (!key) {
			state.error = "usage monitor unavailable";
			state.snapshot = null;
			state.loading = false;
		} else if (state.activeKey !== key) {
			resetUsageState(key);
		}

		const lines = buildZaiUsageIndicatorLines(
			{
				snapshot: state.snapshot,
				loading: state.loading && state.inFlightKey === state.activeKey,
				error: state.error,
			},
			ctx.ui.theme,
		);
		const signature = lines.join("\n");
		if (signature === state.lastStatusSignature) return;
		ctx.ui.setStatus(ZAI_USAGE_STATUS_KEY, lines[0]);
		state.lastStatusSignature = signature;
	}

	async function refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
		if (!state.active) return;
		if (!ctx.model || !isZaiUsageModel(ctx.model)) {
			syncStatus(ctx);
			return;
		}

		const key = getZaiUsageKey(ctx.model);
		const origin = getZaiUsageOrigin(ctx.model);
		if (!key || !origin) {
			state.error = "usage monitor unavailable";
			state.snapshot = null;
			state.loading = false;
			syncStatus(ctx);
			return;
		}
		if (state.activeKey !== key) resetUsageState(key);

		if (state.inFlight && state.inFlightKey === key) {
			syncStatus(ctx);
			return state.inFlight;
		}

		const now = Date.now();
		if (!options?.force && now - state.lastFetchStartedAt < ZAI_USAGE_MIN_FETCH_INTERVAL_MS) {
			syncStatus(ctx);
			return;
		}

		state.loading = true;
		state.error = state.snapshot ? state.error : null;
		state.lastFetchStartedAt = now;
		syncStatus(ctx);

		const requestKey = key;
		const request = (async () => {
			try {
				const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
				if (!resolvedAuth.ok) throw new Error(resolvedAuth.error || "auth not configured");
				const authToken = extractZaiAuthToken(resolvedAuth);
				if (!authToken) throw new Error("auth token unavailable");

				const response = await fetch(`${origin}${ZAI_USAGE_MONITOR_PATH}`, {
					method: "GET",
					headers: {
						Authorization: authToken,
						"Accept-Language": "en-US,en",
						"Content-Type": "application/json",
					},
					signal: AbortSignal.timeout(ZAI_USAGE_REQUEST_TIMEOUT_MS),
				});
				const payload = await parseJsonResponse(response);
				if (!response.ok) throw new Error(describeUsageError(payload, response.status));
				if (hasUsageError(payload)) throw new Error(describeUsageError(payload, response.status));

				const snapshot = parseZaiQuotaSnapshot(payload);
				if (!snapshot.fiveHour && !snapshot.sevenDay) {
					throw new Error("quota response did not expose 5-hour or 7-day data");
				}
				if (state.activeKey === requestKey) {
					state.snapshot = snapshot;
					state.error = null;
				}
			} catch (error) {
				if (state.activeKey === requestKey) {
					state.error = errorMessage(error);
					if (!state.snapshot) state.snapshot = null;
				}
			} finally {
				if (state.activeKey === requestKey) state.loading = false;
				if (state.inFlight === request) {
					state.inFlight = null;
					state.inFlightKey = null;
				}
				syncStatus(ctx);
			}
		})();

		state.inFlight = request;
		state.inFlightKey = requestKey;
		return request;
	}

	function scheduleRefresh(ctx: ExtensionContext, delayMs: number, force = true): void {
		if (state.deferredHandle) clearTimeout(state.deferredHandle);
		state.deferredHandle = setTimeout(() => {
			state.deferredHandle = null;
			if (!state.active) return;
			void refresh(ctx, { force });
		}, delayMs);
		state.deferredHandle.unref?.();
	}

	function start(ctx: ExtensionContext): void {
		clearTimers();
		state.active = true;
		syncStatus(ctx);
		syncInlineFooter(ctx);
		if (!ctx.hasUI) return;
		state.intervalHandle = setInterval(() => {
			void refresh(ctx);
		}, ZAI_USAGE_REFRESH_INTERVAL_MS);
		state.intervalHandle.unref?.();
		if (ctx.model && isZaiUsageModel(ctx.model)) {
			void refresh(ctx, { force: true });
		}
	}

	function stop(ctx: ExtensionContext): void {
		state.active = false;
		clearTimers();
		resetUsageState(null);
		clearStatus(ctx);
		syncInlineFooter(ctx);
	}

	return {
		refresh,
		scheduleRefresh,
		syncStatus,
		start,
		stop,
	};
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`usage monitor returned invalid JSON (${response.status})`);
	}
}

export function hasUsageError(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const candidate = payload as { success?: unknown; code?: unknown };
	if (candidate.success === true) return false;
	if (candidate.success === false) return true;
	if (typeof candidate.code === "number") return candidate.code !== 0 && candidate.code !== 200;
	if (typeof candidate.code === "string") {
		const normalized = candidate.code.trim();
		return normalized !== "0" && normalized !== "200";
	}
	return false;
}

function describeUsageError(payload: unknown, status: number): string {
	if (payload && typeof payload === "object") {
		const candidate = payload as { msg?: unknown; message?: unknown; code?: unknown };
		const msg =
			(typeof candidate.msg === "string" && candidate.msg.trim()) ||
			(typeof candidate.message === "string" && candidate.message.trim()) ||
			undefined;
		if (msg) return msg;
		if (candidate.code !== undefined) return `usage monitor error ${String(candidate.code)}`;
	}
	return `usage monitor request failed (${status})`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

export default function zaiCodingPlan(pi: ExtensionAPI): void {
	registerZaiCodingPlan(pi);

	let ownsFooter = false;
	let jjFooterMetadataState:
		| {
				repoRoot: string;
				metadata: JjRepoMetadata | null;
				loading: boolean;
				error: string | null;
				request: Promise<void> | null;
		  }
		| null = null;

	function makeExec(): ExecLike {
		return async (command, args, options) => {
			if (typeof pi.exec !== "function") throw new Error("pi.exec unavailable");
			const result = await pi.exec(command, args, options);
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				code: result.code,
			};
		};
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

	function syncInlineFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (ctx.model && isZaiUsageModel(ctx.model)) {
			ctx.ui.setFooter((tui, theme, footerData) => {
				let lastLines: string[] | null = null;
				const unsubscribe = footerData.onBranchChange(() => {
					try {
						invalidateJjFooterMetadata(ctx.sessionManager.getCwd());
					} catch {}
					tui.requestRender();
				});
				return {
					dispose: unsubscribe,
					invalidate() {},
					render(width: number): string[] {
						try {
							const repoChromeLabel = getRepoChromeLabel(ctx.sessionManager.getCwd(), footerData.getGitBranch(), () =>
								tui.requestRender(),
							);
							lastLines = buildInlineFooter(ctx, footerData, theme, width, repoChromeLabel);
							return lastLines;
						} catch {
							return buildFooterFallbackLines(theme, width, lastLines);
						}
					},
				};
			});
			ownsFooter = true;
			return;
		}
		if (ownsFooter) {
			ctx.ui.setFooter(undefined);
			ownsFooter = false;
		}
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.provider !== ZAI_CODING_PLAN_PROVIDER_ID || ctx.model.id !== "glm-5.1") {
			return undefined;
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${GLM_51_REIN_IN_PROMPT}`
				: GLM_51_REIN_IN_PROMPT,
		};
	});

	const usageTracker = createUsageTracker(syncInlineFooter);

	pi.on("session_start", async (_event, ctx) => {
		usageTracker.start(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		usageTracker.syncStatus(ctx);
		syncInlineFooter(ctx);
		void usageTracker.refresh(ctx, { force: true });
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.model || !isZaiUsageModel(ctx.model)) return;
		usageTracker.scheduleRefresh(ctx, ZAI_USAGE_POST_TURN_REFRESH_DELAY_MS, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		usageTracker.stop(ctx);
	});
}
