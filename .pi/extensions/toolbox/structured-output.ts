export type CheckerFindingCategory =
	| "security"
	| "regression"
	| "ui"
	| "performance"
	| "loose_ends"
	| "complexity"
	| "guidance";

export type FindingSeverity = "low" | "medium" | "high";
export type CheckRunStatus = "passed" | "failed" | "blocked" | "error" | "not_run";

export interface CheckerFinding {
	id: string;
	category: CheckerFindingCategory;
	severity: FindingSeverity;
	summary: string;
	details: string;
	suggestedFix: string;
	paths: string[];
}

export interface CheckRunReport {
	command: string;
	source: string;
	status: CheckRunStatus;
	summary: string;
}

export interface CheckerReport {
	findings: CheckerFinding[];
	checksRun: CheckRunReport[];
	unresolvedRisks: string[];
	overallAssessment: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: unknown, fallback: string[] = []): string[] {
	if (!Array.isArray(values)) return [...fallback];
	return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function stringValue(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed) return trimmed;
		}
	}
	return "";
}

function normalizeCheckRun(value: unknown, index: number): CheckRunReport {
	if (!isObject(value)) throw new Error(`checksRun[${index}] must be an object`);
	const status = stringValue(value.status) as CheckRunStatus;
	if (!( ["passed", "failed", "blocked", "error", "not_run"] as const).includes(status)) {
		throw new Error(`checksRun[${index}] has invalid status`);
	}
	return {
		command: stringValue(value.command, value.name, `check-${index + 1}`),
		source: stringValue(value.source, "unknown"),
		status,
		summary: stringValue(value.summary, value.result, value.details),
	};
}

function normalizeFindingCategory(category: string): CheckerFindingCategory | null {
	const normalized = category.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if ((["security", "regression", "ui", "performance", "loose_ends", "complexity", "guidance"] as const).includes(normalized as CheckerFindingCategory)) {
		return normalized as CheckerFindingCategory;
	}
	if (["correctness", "breakage", "breaking_change", "regression_risk"].includes(normalized)) return "regression";
	if (
		[
			"ux",
			"consistency",
			"ui_consistency",
			"accessibility",
			"inclusivity",
			"discoverability",
			"navigation",
			"interaction",
			"clarity",
			"hierarchy",
			"information_architecture",
			"legibility",
			"readability",
			"copy",
			"copy_hierarchy",
			"polish",
			"affordance",
			"friction",
			"usability",
			"wayfinding",
		].includes(normalized)
	) {
		return "ui";
	}
	if (["perf", "efficiency", "performance_risk"].includes(normalized)) return "performance";
	if (
		[
			"cleanup",
			"dead_code",
			"looseends",
			"looseend",
			"maintainability",
			"legacy",
			"obsolete",
			"obsolete_code",
			"superseded",
			"unused",
			"unused_state",
			"unused_helper",
			"dead_state",
			"stale",
			"stale_docs",
			"stale_tests",
			"stale_config",
			"duplication",
			"duplicate_code",
			"redundancy",
		].includes(normalized)
	) {
		return "loose_ends";
	}
	if (["simplicity", "overscoping", "overengineering", "architecture", "design", "cognitive_load", "overload", "duplicate_plumbing"].includes(normalized)) {
		return "complexity";
	}
	if (["agents", "agent", "instructions", "conventions", "policy", "process", "process_violation", "workflow", "workflow_violation"].includes(normalized)) {
		return "guidance";
	}
	return null;
}

function normalizeFindingSeverity(severity: string): FindingSeverity | null {
	const normalized = severity.trim().toLowerCase();
	if ((["low", "medium", "high"] as const).includes(normalized as FindingSeverity)) return normalized as FindingSeverity;
	if (["minor", "small", "info", "informational"].includes(normalized)) return "low";
	if (["moderate", "warning"].includes(normalized)) return "medium";
	if (["critical", "severe", "major"].includes(normalized)) return "high";
	return null;
}

function normalizeFinding(value: unknown, index: number): CheckerFinding {
	if (!isObject(value)) throw new Error(`findings[${index}] must be an object`);
	const category = normalizeFindingCategory(stringValue(value.category));
	if (!category) throw new Error(`findings[${index}] has invalid category`);
	const severity = normalizeFindingSeverity(stringValue(value.severity, value.level));
	if (!severity) throw new Error(`findings[${index}] has invalid severity`);
	return {
		id: stringValue(value.id, `finding-${index + 1}`),
		category,
		severity,
		summary: stringValue(value.summary, value.title, value.description),
		details: stringValue(value.details, value.description, value.rationale),
		suggestedFix: stringValue(value.suggestedFix, value.fix, value.recommendation),
		paths: uniqueStrings(value.paths),
	};
}

export function extractJsonValue(rawText: string): unknown {
	const trimmed = rawText.trim();
	if (!trimmed) throw new Error("Empty structured output");

	const direct = tryParseJson(trimmed);
	if (direct.ok) return direct.value;

	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fencedMatch) {
		const fenced = tryParseJson(fencedMatch[1].trim());
		if (fenced.ok) return fenced.value;
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const sliced = tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
		if (sliced.ok) return sliced.value;
	}

	throw new Error(`Invalid JSON output: ${direct.error}`);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function parseCheckerReport(rawText: string): CheckerReport {
	const value = extractJsonValue(rawText);
	if (!isObject(value)) throw new Error("Checker output must be a JSON object");

	return {
		findings: Array.isArray(value.findings) ? value.findings.map((finding, index) => normalizeFinding(finding, index)) : [],
		checksRun: Array.isArray(value.checksRun) ? value.checksRun.map((checkRun, index) => normalizeCheckRun(checkRun, index)) : [],
		unresolvedRisks: uniqueStrings(value.unresolvedRisks, uniqueStrings(value.risks)),
		overallAssessment: stringValue(value.overallAssessment, value.summary),
	};
}
