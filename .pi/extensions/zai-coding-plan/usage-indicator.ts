import type { Model } from "@mariozechner/pi-ai";

export interface ZaiQuotaWindow {
	kind: "5h" | "7d" | "unknown";
	usedPercent: number | null;
	remainingPercent: number | null;
	usedValue: number | null;
	limitValue: number | null;
	resetAt: number | null;
	signature: string;
	raw: Record<string, unknown>;
}

export interface ZaiQuotaSnapshot {
	fiveHour: ZaiQuotaWindow | null;
	sevenDay: ZaiQuotaWindow | null;
	limits: ZaiQuotaWindow[];
	fetchedAt: number;
}

export interface ZaiUsageIndicatorState {
	snapshot: ZaiQuotaSnapshot | null;
	loading: boolean;
	error: string | null;
}

export interface ZaiUsageThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type InternalQuotaKind = ZaiQuotaWindow["kind"] | "ignore";

const LIMIT_COLLECTION_KEYS = ["limits", "limitlist", "quotas", "quotaitems"];
const USED_PERCENT_KEYS = [
	"usedpercentage",
	"usagepercentage",
	"consumedpercentage",
	"currentpercentage",
	"utilizationpercentage",
	"percentage",
	"usedratio",
	"usageratio",
	"consumedratio",
	"currentratio",
	"utilizationratio",
	"ratio",
];
const REMAINING_PERCENT_KEYS = [
	"remainingpercentage",
	"remainpercentage",
	"availablepercentage",
	"leftpercentage",
	"remainingratio",
	"availableratio",
	"leftratio",
];
const USED_VALUE_KEYS = [
	"currentvalue",
	"currentusage",
	"usedvalue",
	"usedusage",
	"consumedvalue",
	"consumedusage",
	"current",
	"consumed",
	"used",
];
const LIMIT_VALUE_KEYS = ["usage", "usagelimit", "limit", "quota", "total", "totalvalue", "max", "capacity", "allowed"];
const RESET_AT_KEYS = ["resetat", "resettime", "refreshtime", "nextreset", "nextrefreshtime", "expiretime", "expirytime"];

export function isZaiUsageModel(
	model: Pick<Model<any>, "provider" | "baseUrl"> | undefined,
): boolean {
	if (!model) return false;
	const provider = `${model.provider || ""}`.toLowerCase();
	if (provider === "zai" || provider === "zai-coding-plan") return true;
	try {
		return new URL(model.baseUrl).hostname.toLowerCase().endsWith("z.ai");
	} catch {
		return false;
	}
}

export function getZaiUsageOrigin(model: Pick<Model<any>, "baseUrl">): string | null {
	try {
		return new URL(model.baseUrl).origin;
	} catch {
		return null;
	}
}

export function getZaiUsageKey(model: Pick<Model<any>, "provider" | "baseUrl">): string | null {
	const origin = getZaiUsageOrigin(model);
	if (!origin) return null;
	return `${model.provider}@${origin}`;
}

export function extractZaiAuthToken(resolvedAuth: {
	apiKey?: string;
	headers?: Record<string, string>;
}): string | null {
	if (typeof resolvedAuth.apiKey === "string" && resolvedAuth.apiKey.trim()) {
		return resolvedAuth.apiKey.trim();
	}
	if (!resolvedAuth.headers) return null;
	for (const [key, value] of Object.entries(resolvedAuth.headers)) {
		if (typeof value !== "string") continue;
		const normalized = normalizeKey(key);
		if (normalized === "authorization") {
			return value.replace(/^Bearer\s+/i, "").trim() || null;
		}
		if (normalized === "xapikey" || normalized === "apikey") {
			return value.trim() || null;
		}
	}
	return null;
}

export function parseZaiQuotaSnapshot(payload: unknown, fetchedAt = Date.now()): ZaiQuotaSnapshot {
	const root = unwrapPayload(payload);
	const limits = findLimitCollection(root)
		.map((item) => parseQuotaWindow(item, fetchedAt))
		.filter((item): item is ZaiQuotaWindow => item !== null);

	let fiveHour = limits.find((item) => item.kind === "5h") ?? null;
	let sevenDay = limits.find((item) => item.kind === "7d") ?? null;

	if (!fiveHour) fiveHour = limits.find((item) => item.kind === "unknown") ?? limits[0] ?? null;
	if (!sevenDay) {
		sevenDay =
			limits.find((item) => item !== fiveHour && (item.kind === "7d" || item.kind === "unknown")) ??
			limits.find((item) => item !== fiveHour) ??
			null;
	}

	return {
		fiveHour,
		sevenDay,
		limits,
		fetchedAt,
	};
}

export function buildZaiUsageIndicatorLines(
	state: ZaiUsageIndicatorState,
	theme: ZaiUsageThemeLike,
	now = Date.now(),
): string[] {
	const snapshot = state.snapshot;
	const hasQuota = Boolean(snapshot?.fiveHour || snapshot?.sevenDay);
	if (hasQuota && snapshot) {
		const pieces: string[] = [];
		if (snapshot.fiveHour) pieces.push(renderWindow(theme, "5h", snapshot.fiveHour));
		if (snapshot.sevenDay) pieces.push(renderWindow(theme, "7d", snapshot.sevenDay));

		const overallRemaining = Math.min(
			...(snapshot.fiveHour?.remainingPercent != null ? [snapshot.fiveHour.remainingPercent] : []),
			...(snapshot.sevenDay?.remainingPercent != null ? [snapshot.sevenDay.remainingPercent] : []),
		);
		const stale = Boolean(state.error) || now - snapshot.fetchedAt >= 5 * 60_000;
		const dot = theme.fg(
			state.loading ? "accent" : stale ? "warning" : statusColorForRemaining(overallRemaining),
			state.loading ? "◌" : stale ? "◐" : "●",
		);
		const separator = theme.fg("dim", " · ");
		let line = `${dot} ${theme.fg("dim", "z.ai")} ${pieces.join(separator)}`;
		if (state.loading) line += theme.fg("dim", " · sync");
		else if (stale) line += theme.fg(state.error ? "warning" : "dim", state.error ? " · stale" : " · cached");
		return [line];
	}

	if (state.loading) {
		return [theme.fg("dim", "◌ z.ai quota…")];
	}
	if (state.error) {
		return [theme.fg("dim", "◌ z.ai quota unavailable")];
	}
	return [theme.fg("dim", "◌ z.ai quota…")];
}

function renderWindow(theme: ZaiUsageThemeLike, label: string, window: ZaiQuotaWindow): string {
	const value = formatWindowValue(window);
	return `${theme.fg("dim", `${label} `)}${theme.bold(theme.fg(statusColorForRemaining(window.remainingPercent), value))}`;
}

function formatWindowValue(window: ZaiQuotaWindow): string {
	if (window.remainingPercent != null) return `${Math.round(window.remainingPercent)}%`;
	if (window.usedValue != null && window.limitValue != null) {
		const remaining = Math.max(0, window.limitValue - window.usedValue);
		return `${formatCompactNumber(remaining)}/${formatCompactNumber(window.limitValue)}`;
	}
	return "—";
}

function statusColorForRemaining(remainingPercent: number | null): string {
	if (remainingPercent == null || !Number.isFinite(remainingPercent)) return "muted";
	if (remainingPercent <= 15) return "error";
	if (remainingPercent <= 35) return "warning";
	return "success";
}

function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value)) return "0";
	if (Math.abs(value) >= 1_000_000) return `${trimFraction((value / 1_000_000).toFixed(1))}m`;
	if (Math.abs(value) >= 1_000) return `${trimFraction((value / 1_000).toFixed(1))}k`;
	return `${Math.round(value)}`;
}

function trimFraction(value: string): string {
	return value.replace(/\.0$/, "");
}

function parseQuotaWindow(item: Record<string, unknown>, fetchedAt: number): ZaiQuotaWindow | null {
	const signature = buildSignature(item);
	const resetAt = findTimeField(item, RESET_AT_KEYS);
	const kind = classifyQuotaWindow(item, signature, { fetchedAt, resetAt });
	if (kind === "ignore") return null;

	let usedPercent = findNumericField(item, USED_PERCENT_KEYS);
	let remainingPercent = findNumericField(item, REMAINING_PERCENT_KEYS);
	const usedValue = findNumericField(item, USED_VALUE_KEYS);
	const limitValue = findNumericField(item, LIMIT_VALUE_KEYS);

	usedPercent = normalizePercent(usedPercent);
	remainingPercent = normalizePercent(remainingPercent);

	if (usedPercent == null && remainingPercent != null) usedPercent = clampPercent(100 - remainingPercent);
	if (remainingPercent == null && usedPercent != null) remainingPercent = clampPercent(100 - usedPercent);
	if (usedPercent == null && usedValue != null && limitValue != null && limitValue > 0) {
		usedPercent = clampPercent((usedValue / limitValue) * 100);
	}
	if (remainingPercent == null && usedPercent != null) remainingPercent = clampPercent(100 - usedPercent);

	return {
		kind,
		usedPercent,
		remainingPercent,
		usedValue,
		limitValue,
		resetAt,
		signature,
		raw: item,
	};
}

function classifyQuotaWindow(
	item: Record<string, unknown>,
	signature: string,
	options: { fetchedAt: number; resetAt: number | null },
): InternalQuotaKind {
	const type = stringValue(item.type);
	const normalizedType = type ? normalizeSignature(type) : "";
	const raw = `${normalizedType ? normalizedType + " " : ""}${signature}`.trim();
	const unit = parseNumberish(item.unit);
	const number = parseNumberish(item.number);
	const horizonMs = options.resetAt != null ? options.resetAt - options.fetchedAt : null;

	if (normalizedType === "tokenslimit") {
		if (unit === 3 && number === 5) return "5h";
		if (unit === 6 && number === 1) return "7d";
		if (horizonMs != null && horizonMs > 0) {
			if (horizonMs <= 12 * 60 * 60 * 1000) return "5h";
			if (horizonMs >= 5 * 24 * 60 * 60 * 1000 && horizonMs <= 10 * 24 * 60 * 60 * 1000) return "7d";
		}
	}

	if (matchesAny(raw, ["week", "weekly", "7day", "7d"])) return "7d";
	if (matchesAny(raw, ["tokenslimit", "token", "5hour", "5h", "hour"])) return "5h";
	if (matchesAny(raw, ["month", "monthly", "mcp", "websearch", "webreader", "vision", "timelimit"])) {
		return "ignore";
	}
	return "unknown";
}

function unwrapPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	if (isRecord(payload.data)) return payload.data;
	return payload;
}

function findLimitCollection(payload: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(payload)) return payload.filter(isRecord);
	if (!isRecord(payload)) return [];
	const direct = Object.entries(payload).find(([key, value]) => {
		const normalized = normalizeKey(key);
		return LIMIT_COLLECTION_KEYS.includes(normalized) && Array.isArray(value);
	});
	if (direct && Array.isArray(direct[1])) return direct[1].filter(isRecord);
	for (const value of Object.values(payload)) {
		const nested = findLimitCollection(value);
		if (nested.length > 0) return nested;
	}
	return [];
}

function buildSignature(item: Record<string, unknown>): string {
	const values: string[] = [];
	for (const [path, value] of collectEntries(item)) {
		if (typeof value === "string" && value.trim()) {
			values.push(normalizeSignature(path));
			values.push(normalizeSignature(value));
		}
	}
	return values.join(" ");
}

function findNumericField(item: Record<string, unknown>, keys: string[]): number | null {
	for (const [path, value] of collectEntries(item)) {
		const normalizedPath = normalizeKey(path);
		if (!keys.some((key) => normalizedPath === key || normalizedPath.endsWith(key) || normalizedPath.includes(key))) continue;
		const parsed = parseNumberish(value);
		if (parsed != null) return parsed;
	}
	return null;
}

function findTimeField(item: Record<string, unknown>, keys: string[]): number | null {
	for (const [path, value] of collectEntries(item)) {
		const normalizedPath = normalizeKey(path);
		if (!keys.some((key) => normalizedPath === key || normalizedPath.endsWith(key) || normalizedPath.includes(key))) continue;
		const parsed = parseTimestamp(value);
		if (parsed != null) return parsed;
	}
	return null;
}

function collectEntries(
	value: unknown,
	prefix = "",
	depth = 0,
	results: Array<[string, unknown]> = [],
): Array<[string, unknown]> {
	if (depth > 2 || !isRecord(value)) return results;
	for (const [key, item] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		results.push([path, item]);
		if (isRecord(item)) collectEntries(item, path, depth + 1, results);
	}
	return results;
}

function parseNumberish(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/,/g, "").replace(/%$/, "");
	if (!normalized) return null;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value > 1_000_000_000_000) return value;
		if (value > 1_000_000_000) return value * 1000;
		return null;
	}
	if (typeof value !== "string") return null;
	const numeric = parseNumberish(value);
	if (numeric != null) return parseTimestamp(numeric);
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function normalizePercent(value: number | null): number | null {
	if (value == null || !Number.isFinite(value)) return null;
	if (value >= 0 && value <= 1) return clampPercent(value * 100);
	return clampPercent(value);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSignature(value: string): string {
	return normalizeKey(value).replace(/\s+/g, "");
}

function matchesAny(text: string, needles: string[]): boolean {
	return needles.some((needle) => text.includes(needle));
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
