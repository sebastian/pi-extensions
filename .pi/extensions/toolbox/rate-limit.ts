import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOOGLE_RATE_LIMIT_DOCS_URL = "https://ai.google.dev/gemini-api/docs/rate-limits";
const GOOGLE_RATE_LIMIT_USAGE_URL = "https://ai.dev/rate-limit";
const MAX_AUTO_WAIT_MS = 60_000;
const RETRY_CUSHION_MS = 500;

type JsonRecord = Record<string, unknown>;

interface RateLimitState {
	modelKey: string;
	retryAt: number;
}

export interface RateLimitInfo {
	provider: "google" | "unknown";
	code?: number;
	status?: string;
	model?: string;
	quotaMetric?: string;
	quotaId?: string;
	quotaValue?: string;
	retryAfterSeconds?: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): JsonRecord | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseDurationSeconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const retryInfo = trimmed.match(/^(\d+(?:\.\d+)?)s$/i);
	if (retryInfo) return Number(retryInfo[1]);

	const retryIn = trimmed.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b/i);
	if (!retryIn) return undefined;
	const amount = Number(retryIn[1]);
	const unit = retryIn[2].toLowerCase();
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	if (unit.startsWith("ms") || unit.startsWith("millisecond")) return amount / 1000;
	if (unit === "m" || unit.startsWith("minute")) return amount * 60;
	if (unit === "h" || unit.startsWith("hour")) return amount * 3600;
	return amount;
}

function mergeRetryDelay(info: RateLimitInfo, seconds: number | undefined): void {
	if (seconds === undefined) return;
	info.retryAfterSeconds = Math.max(info.retryAfterSeconds ?? 0, seconds);
}

function inspectRateLimitObject(value: unknown, info: RateLimitInfo, seen = new Set<unknown>()): void {
	if (typeof value === "string") {
		mergeRetryDelay(info, parseDurationSeconds(value));
		const parsed = parseJsonObject(value);
		if (parsed) inspectRateLimitObject(parsed, info, seen);
		return;
	}
	if (!isRecord(value) || seen.has(value)) return;
	seen.add(value);

	if (typeof value.code === "number") info.code = value.code;
	if (typeof value.status === "string") info.status = value.status;
	if (typeof value.message === "string") {
		mergeRetryDelay(info, parseDurationSeconds(value.message));
		const parsedMessage = parseJsonObject(value.message);
		if (parsedMessage) inspectRateLimitObject(parsedMessage, info, seen);
	}

	if (isRecord(value.error)) inspectRateLimitObject(value.error, info, seen);

	if (Array.isArray(value.details)) {
		for (const detail of value.details) inspectRateLimitObject(detail, info, seen);
	}

	const type = typeof value["@type"] === "string" ? value["@type"] : undefined;
	if (type?.endsWith("google.rpc.RetryInfo")) {
		mergeRetryDelay(info, parseDurationSeconds(value.retryDelay));
	}

	if (type?.endsWith("google.rpc.QuotaFailure") && Array.isArray(value.violations)) {
		for (const violation of value.violations) {
			if (!isRecord(violation)) continue;
			if (typeof violation.quotaMetric === "string") info.quotaMetric = violation.quotaMetric;
			if (typeof violation.quotaId === "string") info.quotaId = violation.quotaId;
			if (typeof violation.quotaValue === "string") info.quotaValue = violation.quotaValue;
			if (isRecord(violation.quotaDimensions) && typeof violation.quotaDimensions.model === "string") {
				info.model = violation.quotaDimensions.model;
			}
		}
	}
}

function looksLikeRateLimit(raw: string, info: RateLimitInfo): boolean {
	return (
		info.code === 429 ||
		info.status === "RESOURCE_EXHAUSTED" ||
		/\b429\b|too many requests|resource_exhausted|quota exceeded|rate.?limit/i.test(raw)
	);
}

function simplifyQuotaMetric(metric: string | undefined): string | undefined {
	if (!metric) return undefined;
	const last = metric.split("/").pop() ?? metric;
	return last.replace(/_/g, " ");
}

function formatDuration(seconds: number): string {
	const rounded = Math.ceil(seconds);
	if (rounded < 60) return `${rounded}s`;
	const minutes = Math.floor(rounded / 60);
	const remainingSeconds = rounded % 60;
	return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

export function formatRateLimitMessage(info: RateLimitInfo, fallbackModel?: string): string {
	const provider = info.provider === "google" ? "Gemini" : "Provider";
	const model = info.model ?? fallbackModel;
	const lines = [`${provider} rate limit hit${model ? ` for ${model}` : ""} (429).`];

	const quota = simplifyQuotaMetric(info.quotaMetric);
	if (quota || info.quotaValue) {
		lines.push(`Quota: ${quota ?? "request quota"}${info.quotaValue ? ` (limit ${info.quotaValue})` : ""}.`);
	}
	if (info.retryAfterSeconds !== undefined) {
		lines.push(`Retry after about ${formatDuration(info.retryAfterSeconds)}.`);
	}
	if (info.provider === "google") {
		lines.push(`Usage: ${GOOGLE_RATE_LIMIT_USAGE_URL}`);
		lines.push(`Docs: ${GOOGLE_RATE_LIMIT_DOCS_URL}`);
	}
	return lines.join("\n");
}

export function extractRateLimitInfo(rawError: string): RateLimitInfo | undefined {
	const info: RateLimitInfo = { provider: /google|gemini|generativelanguage\.googleapis\.com/i.test(rawError) ? "google" : "unknown" };
	inspectRateLimitObject(rawError, info);
	const parsed = parseJsonObject(rawError.replace(/^Error:\s*/i, ""));
	if (parsed) inspectRateLimitObject(parsed, info);

	const retryDelay = rawError.match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b/i);
	if (retryDelay) mergeRetryDelay(info, parseDurationSeconds(retryDelay[0]));

	const model = rawError.match(/model:\s*([A-Za-z0-9._:/-]+)/i);
	if (model && !info.model) info.model = model[1];

	return looksLikeRateLimit(rawError, info) ? info : undefined;
}

function normalizeModelId(model: string | undefined): string | undefined {
	if (!model) return undefined;
	return model.replace(/^models\//, "");
}

function modelKey(provider: string | undefined, model: string | undefined): string | undefined {
	const normalizedModel = normalizeModelId(model);
	if (!provider || !normalizedModel) return undefined;
	return `${provider}/${normalizedModel}`.toLowerCase();
}

function payloadModel(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	return typeof payload.model === "string" ? payload.model : undefined;
}

function providerForPayloadModel(modelId: string | undefined, ctx: ExtensionContext): string | undefined {
	const normalizedModel = normalizeModelId(modelId);
	if (!normalizedModel) return ctx.model?.provider;
	if (ctx.model && normalizeModelId(ctx.model.id) === normalizedModel) return ctx.model.provider;
	try {
		const all = ctx.modelRegistry.getAll?.() ?? ctx.modelRegistry.getAvailable();
		const match = all.find((model) => normalizeModelId(model.id) === normalizedModel);
		return match?.provider ?? ctx.model?.provider;
	} catch {
		return ctx.model?.provider;
	}
}

function requestModelKey(payload: unknown, ctx: ExtensionContext): string | undefined {
	const modelId = payloadModel(payload) ?? ctx.model?.id;
	return modelKey(providerForPayloadModel(modelId, ctx), modelId);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(new Error("Rate-limit wait aborted"));
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, ms);
		function done() {
			cleanup();
			resolve();
		}
		function abort() {
			cleanup();
			reject(new Error("Rate-limit wait aborted"));
		}
		function cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForRateLimit(state: RateLimitState, ctx: ExtensionContext): Promise<void> {
	const waitMs = state.retryAt - Date.now();
	if (waitMs <= 0) return;
	const seconds = Math.ceil(waitMs / 1000);
	if (ctx.hasUI) {
		ctx.ui.notify(`Rate limited; waiting ${formatDuration(seconds)} before retrying ${state.modelKey}.`, "warning");
		ctx.ui.setStatus("rate-limit", ctx.ui.theme.fg("warning", `rate limit: waiting ${formatDuration(seconds)}`));
	}
	try {
		await sleep(waitMs, ctx.signal);
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("rate-limit", undefined);
	}
}

export default function registerRateLimitHandling(pi: ExtensionAPI): void {
	const rateLimits = new Map<string, RateLimitState>();

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return undefined;

		const info = extractRateLimitInfo(message.errorMessage);
		if (!info) return undefined;

		const key = modelKey(message.provider, info.model ?? message.model);
		const formattedMessage = formatRateLimitMessage(info, message.model);
		if (key && info.retryAfterSeconds !== undefined) {
			const retryAfterMs = Math.ceil(info.retryAfterSeconds * 1000) + RETRY_CUSHION_MS;
			if (retryAfterMs <= MAX_AUTO_WAIT_MS) {
				rateLimits.set(key, {
					modelKey: key,
					retryAt: Date.now() + retryAfterMs,
				});
			}
		}

		return { message: { ...message, errorMessage: formattedMessage } };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const key = requestModelKey(event.payload, ctx);
		if (!key) return undefined;
		const state = rateLimits.get(key);
		if (!state) return undefined;
		if (state.retryAt <= Date.now()) {
			rateLimits.delete(key);
			return undefined;
		}
		try {
			await waitForRateLimit(state, ctx);
		} catch {
			// The active turn was likely aborted while we were waiting. Let pi's
			// normal abort handling take over without logging an extension error.
		}
		rateLimits.delete(key);
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		rateLimits.clear();
		if (ctx.hasUI) ctx.ui.setStatus("rate-limit", undefined);
	});
}
