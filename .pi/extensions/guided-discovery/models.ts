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

const PREFERRED_MODEL_ORDER = [
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.3-codex",
	"zai-coding-plan/glm-5.1",
	"huggingface/zai-org/GLM-5.1",
	"zai/zai-org/GLM-5.1",
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

function preferredModelIndex(ref: string): number {
	const normalized = normalizeRef(ref);
	const index = PREFERRED_MODEL_ORDER.findIndex((candidate) => normalizeRef(candidate) === normalized);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function rankModelRefs(availableRefs: string[]): string[] {
	return uniqueRefs(availableRefs).sort((left, right) => {
		const preferredDiff = preferredModelIndex(left) - preferredModelIndex(right);
		if (preferredDiff !== 0) return preferredDiff;
		return normalizeRef(left).localeCompare(normalizeRef(right));
	});
}

export function resolveWorkflowModelsFromRefs(availableRefs: string[], currentModelRef?: string): WorkflowModelPlan {
	const available = uniqueRefs(availableRefs);
	const ranked = rankModelRefs(available);
	const primary =
		pickFirstAvailable(available, ["openai-codex/gpt-5.4"]) ??
		(currentModelRef && pickFirstAvailable(available, [currentModelRef])) ??
		ranked[0];

	const checkers: string[] = [];
	if (primary) checkers.push(primary);

	const companion = pickFirstAvailable(
		available.filter((ref) => normalizeRef(ref) !== normalizeRef(primary ?? "")),
		[
			"openai-codex/gpt-5.3-codex",
			"zai-coding-plan/glm-5.1",
			"huggingface/zai-org/GLM-5.1",
			"zai/zai-org/GLM-5.1",
		],
	);
	if (companion && !checkers.includes(companion)) checkers.push(companion);

	if (checkers.length === 0 && primary) checkers.push(primary);
	return { primary, checkers };
}

export function resolveReviewModelsFromRefs(availableRefs: string[], currentModelRef?: string): ReviewModelPlan {
	const ranked = rankModelRefs(availableRefs);
	const implementation =
		(currentModelRef && pickFirstAvailable(ranked, [currentModelRef])) ??
		ranked[0];
	const reviewers = ranked.filter((ref) => normalizeRef(ref) !== normalizeRef(implementation ?? "")).slice(0, 2);
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
