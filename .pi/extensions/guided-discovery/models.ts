import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface WorkflowModelPlan {
	primary: string | undefined;
	checkers: string[];
}

function normalizeRef(ref: string): string {
	return ref.trim().toLowerCase();
}

function toModelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function pickFirstAvailable(availableRefs: string[], candidates: string[]): string | undefined {
	const normalized = new Map(availableRefs.map((ref) => [normalizeRef(ref), ref]));
	for (const candidate of candidates) {
		const match = normalized.get(normalizeRef(candidate));
		if (match) return match;
	}
	return undefined;
}

export function resolveWorkflowModelsFromRefs(availableRefs: string[], currentModelRef?: string): WorkflowModelPlan {
	const available = [...new Set(availableRefs)];
	const primary =
		pickFirstAvailable(available, ["openai-codex/gpt-5.4"]) ??
		(currentModelRef && pickFirstAvailable(available, [currentModelRef])) ??
		available[0];

	const checkerPreferences = [
		primary,
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.3-codex",
		"huggingface/zai-org/GLM-5.1",
		"zai/zai-org/GLM-5.1",
		currentModelRef,
	].filter((value): value is string => Boolean(value));

	const checkers: string[] = [];
	for (const candidate of checkerPreferences) {
		const resolved = pickFirstAvailable(available, [candidate]);
		if (!resolved) continue;
		if (!checkers.includes(resolved)) checkers.push(resolved);
	}

	if (checkers.length === 0 && primary) checkers.push(primary);
	return { primary, checkers };
}

export function resolveWorkflowModels(ctx: ExtensionContext): WorkflowModelPlan {
	const availableRefs = ctx.modelRegistry.getAvailable().map((model) => toModelRef(model));
	const currentModelRef = ctx.model ? toModelRef(ctx.model) : undefined;
	return resolveWorkflowModelsFromRefs(availableRefs, currentModelRef);
}
