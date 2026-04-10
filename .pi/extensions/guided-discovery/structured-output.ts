export type CheckerFindingCategory =
	| "security"
	| "regression"
	| "ui"
	| "performance"
	| "loose_ends"
	| "complexity"
	| "checks";

export type FindingSeverity = "low" | "medium" | "high";
export type CheckRunStatus = "passed" | "failed" | "blocked" | "error" | "not_run";
export type CoverageStatus = "implemented" | "partial" | "missing" | "superseded";
export type ValidationRecommendation = "finish" | "reformulate" | "accept";

export interface DecompositionPhase {
	id: string;
	title: string;
	goal: string;
	instructions: string[];
	dependsOn: string[];
	touchedPaths: string[];
	parallelSafe: boolean;
}

export interface DecompositionPlan {
	phases: DecompositionPhase[];
	notes: string[];
}

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

export interface ValidationCoverage {
	item: string;
	status: CoverageStatus;
	evidence: string;
	paths: string[];
}

export interface ValidationDiscrepancy {
	item: string;
	status: Exclude<CoverageStatus, "implemented">;
	reason: string;
	suggestedAction: string;
}

export interface ValidationReport {
	coverage: ValidationCoverage[];
	discrepancies: ValidationDiscrepancy[];
	summary: string;
	recommendation: ValidationRecommendation;
	materialDiscrepancies: boolean;
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

function booleanValue(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizePhase(value: unknown, index: number): DecompositionPhase {
	if (!isObject(value)) throw new Error(`Phase ${index + 1} must be an object`);

	const goal = stringValue(value.goal, value.objective, value.description, value.summary);
	const instructions = uniqueStrings(value.instructions, uniqueStrings(value.steps, goal ? [goal] : []));
	const title = stringValue(value.title, value.name, goal, `Phase ${index + 1}`);

	return {
		id: stringValue(value.id, `phase-${index + 1}`),
		title,
		goal: goal || title,
		instructions: instructions.length > 0 ? instructions : [title],
		dependsOn: uniqueStrings(value.dependsOn, uniqueStrings(value.dependencies)),
		touchedPaths: uniqueStrings(value.touchedPaths, uniqueStrings(value.paths)),
		parallelSafe: booleanValue(value.parallelSafe, booleanValue(value.canParallelize, false)),
	};
}

function normalizeCheckRun(value: unknown, index: number): CheckRunReport {
	if (!isObject(value)) throw new Error(`checksRun[${index}] must be an object`);
	const status = stringValue(value.status) as CheckRunStatus;
	if (!(["passed", "failed", "blocked", "error", "not_run"] as const).includes(status)) {
		throw new Error(`checksRun[${index}] has invalid status`);
	}
	return {
		command: stringValue(value.command, value.name, `check-${index + 1}`),
		source: stringValue(value.source, "unknown"),
		status,
		summary: stringValue(value.summary, value.result, value.details),
	};
}

function normalizeFinding(value: unknown, index: number): CheckerFinding {
	if (!isObject(value)) throw new Error(`findings[${index}] must be an object`);
	const category = stringValue(value.category) as CheckerFindingCategory;
	if (!(["security", "regression", "ui", "performance", "loose_ends", "complexity", "checks"] as const).includes(category)) {
		throw new Error(`findings[${index}] has invalid category`);
	}
	const severity = stringValue(value.severity, value.level) as FindingSeverity;
	if (!(["low", "medium", "high"] as const).includes(severity)) {
		throw new Error(`findings[${index}] has invalid severity`);
	}
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

function normalizeCoverage(value: unknown, index: number): ValidationCoverage {
	if (!isObject(value)) throw new Error(`coverage[${index}] must be an object`);
	const status = stringValue(value.status) as CoverageStatus;
	if (!(["implemented", "partial", "missing", "superseded"] as const).includes(status)) {
		throw new Error(`coverage[${index}] has invalid status`);
	}
	return {
		item: stringValue(value.item, value.planItem, value.requirement, `Item ${index + 1}`),
		status,
		evidence: stringValue(value.evidence, value.notes, value.reason),
		paths: uniqueStrings(value.paths),
	};
}

function normalizeDiscrepancy(value: unknown, index: number): ValidationDiscrepancy {
	if (!isObject(value)) throw new Error(`discrepancies[${index}] must be an object`);
	const status = stringValue(value.status) as ValidationDiscrepancy["status"];
	if (!(["partial", "missing", "superseded"] as const).includes(status)) {
		throw new Error(`discrepancies[${index}] has invalid status`);
	}
	return {
		item: stringValue(value.item, value.planItem, `Discrepancy ${index + 1}`),
		status,
		reason: stringValue(value.reason, value.details, value.summary),
		suggestedAction: stringValue(value.suggestedAction, value.recommendation, value.fix),
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

export function parseDecompositionPlan(rawText: string): DecompositionPlan {
	const value = extractJsonValue(rawText);
	if (!isObject(value)) throw new Error("Decomposition output must be a JSON object");
	if (!Array.isArray(value.phases)) throw new Error("Decomposition output must contain a phases array");

	const phases = value.phases.map((phase, index) => normalizePhase(phase, index));
	if (phases.length === 0) throw new Error("Decomposition output must contain at least one phase");

	return {
		phases,
		notes: uniqueStrings(value.notes, uniqueStrings(value.warnings)),
	};
}

export function parseCheckerReport(rawText: string): CheckerReport {
	const value = extractJsonValue(rawText);
	if (!isObject(value)) throw new Error("Checker output must be a JSON object");

	const findings = Array.isArray(value.findings) ? value.findings.map((finding, index) => normalizeFinding(finding, index)) : [];
	const checksRun = Array.isArray(value.checksRun)
		? value.checksRun.map((checkRun, index) => normalizeCheckRun(checkRun, index))
		: [];

	return {
		findings,
		checksRun,
		unresolvedRisks: uniqueStrings(value.unresolvedRisks, uniqueStrings(value.risks)),
		overallAssessment: stringValue(value.overallAssessment, value.summary),
	};
}

export function parseValidationReport(rawText: string): ValidationReport {
	const value = extractJsonValue(rawText);
	if (!isObject(value)) throw new Error("Validator output must be a JSON object");

	const coverage = Array.isArray(value.coverage) ? value.coverage.map((item, index) => normalizeCoverage(item, index)) : [];
	const discrepancies = Array.isArray(value.discrepancies)
		? value.discrepancies.map((item, index) => normalizeDiscrepancy(item, index))
		: [];
	const recommendation = stringValue(value.recommendation) as ValidationRecommendation;
	if (!(["finish", "reformulate", "accept"] as const).includes(recommendation)) {
		throw new Error("Validator output has invalid recommendation");
	}

	return {
		coverage,
		discrepancies,
		summary: stringValue(value.summary, value.overallAssessment),
		recommendation,
		materialDiscrepancies: booleanValue(value.materialDiscrepancies, discrepancies.length > 0),
	};
}

export function hasMaterialDiscrepancies(report: ValidationReport): boolean {
	if (report.materialDiscrepancies) return true;
	return report.discrepancies.some((item) => item.status === "missing" || item.status === "partial");
}
