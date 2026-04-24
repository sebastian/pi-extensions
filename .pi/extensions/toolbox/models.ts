import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface WorkflowModelPlan {
	primary: string | undefined;
	checkers: string[];
}

export interface ReviewModelPlan {
	implementation: string | undefined;
	reviewers: string[];
	topLevel: string[];
}

const GPT_55_MODEL_REF = "openai-codex/gpt-5.5";
const GPT_54_MODEL_REF = "openai-codex/gpt-5.4";
const GPT_53_CODEX_MODEL_REF = "openai-codex/gpt-5.3-codex";
const GLM_51_MODEL_REFS = [
	"zai-coding-plan/glm-5.1",
	"huggingface/zai-org/GLM-5.1",
	"zai/zai-org/GLM-5.1",
] as const;

const PREFERRED_MODEL_ORDER = [
	GPT_55_MODEL_REF,
	GPT_54_MODEL_REF,
	...GLM_51_MODEL_REFS,
	GPT_53_CODEX_MODEL_REF,
] as const;
const PREFERRED_REVIEWER_MODEL_ORDER = [
	GPT_54_MODEL_REF,
	...GLM_51_MODEL_REFS,
	GPT_55_MODEL_REF,
	GPT_53_CODEX_MODEL_REF,
] as const;

function normalizeRef(ref: string): string {
	return ref.trim().toLowerCase();
}

function toModelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function uniqueRefs(refs: string[]): string[] {
	return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
}

function pickFirstAvailable(availableRefs: string[], candidates: string[]): string | undefined {
	const normalized = new Map(availableRefs.map((ref) => [normalizeRef(ref), ref]));
	for (const candidate of candidates) {
		const match = normalized.get(normalizeRef(candidate));
		if (match) return match;
	}
	return undefined;
}

function preferredModelIndex(ref: string, preferredOrder: readonly string[]): number {
	const normalized = normalizeRef(ref);
	const index = preferredOrder.findIndex((candidate) => normalizeRef(candidate) === normalized);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function reviewModelFamily(ref: string): string {
	const normalized = normalizeRef(ref);
	if (GLM_51_MODEL_REFS.some((candidate) => normalizeRef(candidate) === normalized)) return "glm-5.1";
	return normalized;
}

function pickReviewers(ranked: string[], implementation: string | undefined): string[] {
	const implementationRef = normalizeRef(implementation ?? "");
	const usedFamilies = new Set<string>();
	if (implementation) usedFamilies.add(reviewModelFamily(implementation));

	const reviewers: string[] = [];
	for (const ref of ranked) {
		if (normalizeRef(ref) === implementationRef) continue;
		const family = reviewModelFamily(ref);
		if (usedFamilies.has(family)) continue;
		reviewers.push(ref);
		usedFamilies.add(family);
		if (reviewers.length === 2) break;
	}
	return reviewers;
}

function rankModelRefsByOrder(availableRefs: string[], preferredOrder: readonly string[]): string[] {
	return uniqueRefs(availableRefs).sort((left, right) => {
		const preferredDiff = preferredModelIndex(left, preferredOrder) - preferredModelIndex(right, preferredOrder);
		if (preferredDiff !== 0) return preferredDiff;
		return normalizeRef(left).localeCompare(normalizeRef(right));
	});
}

export function rankModelRefs(availableRefs: string[]): string[] {
	return rankModelRefsByOrder(availableRefs, PREFERRED_MODEL_ORDER);
}

export function resolveWorkflowModelsFromRefs(availableRefs: string[], currentModelRef?: string): WorkflowModelPlan {
	const available = uniqueRefs(availableRefs);
	const ranked = rankModelRefs(available);
	const primary =
		pickFirstAvailable(available, [GPT_54_MODEL_REF]) ??
		(currentModelRef && pickFirstAvailable(available, [currentModelRef])) ??
		ranked[0];

	const checkers: string[] = [];
	if (primary) checkers.push(primary);

	const companion = pickFirstAvailable(
		available.filter((ref) => normalizeRef(ref) !== normalizeRef(primary ?? "")),
		[
			GPT_53_CODEX_MODEL_REF,
			...GLM_51_MODEL_REFS,
		],
	);
	if (companion && !checkers.includes(companion)) checkers.push(companion);

	if (checkers.length === 0 && primary) checkers.push(primary);
	return { primary, checkers };
}

export function resolveReviewModelsFromRefs(availableRefs: string[], currentModelRef?: string): ReviewModelPlan {
	const ranked = rankModelRefs(availableRefs);
	const rankedReviewers = rankModelRefsByOrder(availableRefs, PREFERRED_REVIEWER_MODEL_ORDER);
	const implementation =
		(currentModelRef && pickFirstAvailable(ranked, [currentModelRef])) ??
		ranked[0];
	const reviewers = pickReviewers(rankedReviewers, implementation);
	const topLevel = implementation
		? [implementation, ...reviewers]
		: reviewers.slice(0, 3);
	return { implementation, reviewers, topLevel };
}

export function resolveWorkflowModels(ctx: ExtensionContext): WorkflowModelPlan {
	const availableRefs = ctx.modelRegistry.getAvailable().map((model) => toModelRef(model));
	const currentModelRef = ctx.model ? toModelRef(ctx.model) : undefined;
	return resolveWorkflowModelsFromRefs(availableRefs, currentModelRef);
}

export function resolveReviewModels(ctx: ExtensionContext): ReviewModelPlan {
	const availableRefs = ctx.modelRegistry.getAvailable().map((model) => toModelRef(model));
	const currentModelRef = ctx.model ? toModelRef(ctx.model) : undefined;
	return resolveReviewModelsFromRefs(availableRefs, currentModelRef);
}
