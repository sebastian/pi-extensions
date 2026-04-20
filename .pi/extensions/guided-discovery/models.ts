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

export function resolveWorkflowModels(ctx: ExtensionContext): WorkflowModelPlan {
	const availableRefs = ctx.modelRegistry.getAvailable().map((model) => toModelRef(model));
	const currentModelRef = ctx.model ? toModelRef(ctx.model) : undefined;
	return resolveWorkflowModelsFromRefs(availableRefs, currentModelRef);
}
