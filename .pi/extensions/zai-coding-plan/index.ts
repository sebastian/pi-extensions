import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildZaiUsageIndicatorLines,
	resolveZaiAuthToken,
	getZaiUsageKey,
	getZaiUsageOrigin,
	isZaiUsageModel,
	parseZaiQuotaSnapshot,
} from "./usage-indicator.ts";

export const ZAI_PROVIDER_ID = "zai";
export const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_TUNED_MODEL_IDS = new Set(["glm-5.1", "glm-5.2"]);

const ZAI_USAGE_STATUS_KEY = "zai-usage-indicator";
const ZAI_USAGE_MONITOR_PATH = "/api/monitor/usage/quota/limit";
const ZAI_USAGE_REFRESH_INTERVAL_MS = 90_000;
const ZAI_USAGE_MIN_FETCH_INTERVAL_MS = 20_000;
const ZAI_USAGE_POST_TURN_REFRESH_DELAY_MS = 2_000;
const ZAI_USAGE_REQUEST_TIMEOUT_MS = 10_000;

const GLM_5_REIN_IN_PROMPT = [
	"- Be concise, direct, and matter-of-fact.",
	"- Do not be flattering, sycophantic, or overly eager to please.",
	"- Avoid unnecessary praise, reassurance, or agreement.",
	"- Keep preambles short and skip filler.",
	"- State uncertainty briefly when needed, then continue with the best grounded answer.",
].join("\n");

// ponytail: no extension-level modelOverrides API yet; clamp official registry entries
// in place instead of replacing the built-in provider. Replace with modelOverrides when public.
export const GLM_5_EFFECTIVE_CONTEXT_WINDOW = 116_384;

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

type MutableModel = { provider?: string; id?: string; contextWindow?: number };
type ZaiModelRegistryLike = { find?: (provider: string, modelId: string) => MutableModel | undefined };
type ZaiContextLike = { model?: MutableModel; modelRegistry?: ZaiModelRegistryLike };

function isTunedBuiltInZaiModel(model: MutableModel | undefined): boolean {
	return model?.provider === ZAI_PROVIDER_ID && typeof model.id === "string" && ZAI_TUNED_MODEL_IDS.has(model.id);
}

function clampConservativeZaiContextWindow(model: MutableModel | undefined): boolean {
	if (!isTunedBuiltInZaiModel(model)) return false;
	const nextWindow = Math.min(model.contextWindow ?? GLM_5_EFFECTIVE_CONTEXT_WINDOW, GLM_5_EFFECTIVE_CONTEXT_WINDOW);
	if (model.contextWindow === nextWindow) return false;
	model.contextWindow = nextWindow;
	return true;
}

export function applyConservativeZaiContextWindows(ctx: ZaiContextLike): number {
	const models = new Set<MutableModel>();
	for (const id of ZAI_TUNED_MODEL_IDS) {
		const model = ctx.modelRegistry?.find?.(ZAI_PROVIDER_ID, id);
		if (model) models.add(model);
	}
	if (ctx.model) models.add(ctx.model);
	let changed = 0;
	for (const model of models) {
		if (clampConservativeZaiContextWindow(model)) changed++;
	}
	return changed;
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
	return error instanceof Error && error.message ? error.message : String(error);
}

function createUsageTracker() {
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
		if (state.intervalHandle) clearInterval(state.intervalHandle);
		if (state.deferredHandle) clearTimeout(state.deferredHandle);
		state.intervalHandle = null;
		state.deferredHandle = null;
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(ZAI_USAGE_STATUS_KEY, undefined);
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
			{ snapshot: state.snapshot, loading: state.loading && state.inFlightKey === state.activeKey, error: state.error },
			ctx.ui.theme,
		);
		const signature = lines.join("\n");
		if (signature === state.lastStatusSignature) return;
		ctx.ui.setStatus(ZAI_USAGE_STATUS_KEY, lines[0]);
		state.lastStatusSignature = signature;
	}

	async function refresh(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
		if (!state.active || !ctx.hasUI) return;
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
				const authToken = resolveZaiAuthToken(ctx.model!, resolvedAuth);
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
				if (!snapshot.fiveHour && !snapshot.sevenDay) throw new Error("quota response did not expose 5-hour or 7-day data");
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
			void refresh(ctx, { force });
		}, delayMs);
		state.deferredHandle.unref?.();
	}

	function start(ctx: ExtensionContext): void {
		clearTimers();
		state.active = true;
		syncStatus(ctx);
		if (!ctx.hasUI) return;
		state.intervalHandle = setInterval(() => void refresh(ctx), ZAI_USAGE_REFRESH_INTERVAL_MS);
		state.intervalHandle.unref?.();
		if (ctx.model && isZaiUsageModel(ctx.model)) void refresh(ctx, { force: true });
	}

	function stop(ctx: ExtensionContext): void {
		state.active = false;
		clearTimers();
		resetUsageState(null);
		clearStatus(ctx);
	}

	return { refresh, scheduleRefresh, syncStatus, start, stop };
}

export default function zaiCodingPlan(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		applyConservativeZaiContextWindows(ctx);
		if (!isTunedBuiltInZaiModel(ctx.model)) return undefined;
		return { systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${GLM_5_REIN_IN_PROMPT}` : GLM_5_REIN_IN_PROMPT };
	});

	const usageTracker = createUsageTracker();

	pi.on("session_start", async (_event, ctx) => {
		applyConservativeZaiContextWindows(ctx);
		usageTracker.start(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		applyConservativeZaiContextWindows(ctx);
		usageTracker.syncStatus(ctx);
		void usageTracker.refresh(ctx, { force: true });
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model && isZaiUsageModel(ctx.model)) usageTracker.scheduleRefresh(ctx, ZAI_USAGE_POST_TURN_REFRESH_DELAY_MS, true);
	});
	pi.on("session_shutdown", async (_event, ctx) => usageTracker.stop(ctx));
}
