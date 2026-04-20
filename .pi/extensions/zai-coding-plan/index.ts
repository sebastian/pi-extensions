import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

const ZAI_USAGE_WIDGET_KEY = "zai-usage-indicator";
const ZAI_USAGE_MONITOR_PATH = "/api/monitor/usage/quota/limit";
const ZAI_USAGE_REFRESH_INTERVAL_MS = 90_000;
const ZAI_USAGE_MIN_FETCH_INTERVAL_MS = 20_000;
const ZAI_USAGE_POST_TURN_REFRESH_DELAY_MS = 2_000;
const ZAI_USAGE_REQUEST_TIMEOUT_MS = 10_000;

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
	activeKey: string | null;
	snapshot: ReturnType<typeof parseZaiQuotaSnapshot> | null;
	loading: boolean;
	error: string | null;
	lastFetchStartedAt: number;
	inFlight: Promise<void> | null;
	inFlightKey: string | null;
	intervalHandle: ReturnType<typeof setInterval> | null;
	deferredHandle: ReturnType<typeof setTimeout> | null;
	lastWidgetSignature: string | null;
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

function createUsageTracker() {
	const state: UsageTrackerState = {
		activeKey: null,
		snapshot: null,
		loading: false,
		error: null,
		lastFetchStartedAt: 0,
		inFlight: null,
		inFlightKey: null,
		intervalHandle: null,
		deferredHandle: null,
		lastWidgetSignature: null,
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

	function clearWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(ZAI_USAGE_WIDGET_KEY, undefined);
		state.lastWidgetSignature = null;
	}

	function resetUsageState(nextKey: string | null): void {
		state.activeKey = nextKey;
		state.snapshot = null;
		state.loading = false;
		state.error = null;
		state.lastFetchStartedAt = 0;
		state.lastWidgetSignature = null;
	}

	function syncWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!ctx.model || !isZaiUsageModel(ctx.model)) {
			resetUsageState(null);
			clearWidget(ctx);
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
		if (signature === state.lastWidgetSignature) return;
		ctx.ui.setWidget(ZAI_USAGE_WIDGET_KEY, lines, { placement: "belowEditor" });
		state.lastWidgetSignature = signature;
	}

	async function refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
		if (!ctx.model || !isZaiUsageModel(ctx.model)) {
			syncWidget(ctx);
			return;
		}

		const key = getZaiUsageKey(ctx.model);
		const origin = getZaiUsageOrigin(ctx.model);
		if (!key || !origin) {
			state.error = "usage monitor unavailable";
			state.snapshot = null;
			state.loading = false;
			syncWidget(ctx);
			return;
		}
		if (state.activeKey !== key) resetUsageState(key);

		if (state.inFlight && state.inFlightKey === key) {
			syncWidget(ctx);
			return state.inFlight;
		}

		const now = Date.now();
		if (!options?.force && now - state.lastFetchStartedAt < ZAI_USAGE_MIN_FETCH_INTERVAL_MS) {
			syncWidget(ctx);
			return;
		}

		state.loading = true;
		state.error = state.snapshot ? state.error : null;
		state.lastFetchStartedAt = now;
		syncWidget(ctx);

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
				syncWidget(ctx);
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
			void refresh(ctx, { force });
		}, delayMs);
		state.deferredHandle.unref?.();
	}

	function start(ctx: ExtensionContext): void {
		clearTimers();
		syncWidget(ctx);
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
		clearTimers();
		resetUsageState(null);
		clearWidget(ctx);
	}

	return {
		refresh,
		scheduleRefresh,
		syncWidget,
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

	const usageTracker = createUsageTracker();

	pi.on("session_start", async (_event, ctx) => {
		usageTracker.start(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		usageTracker.syncWidget(ctx);
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
