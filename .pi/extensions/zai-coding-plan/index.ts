import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const ZAI_CODING_PLAN_PROVIDER_ID = "zai-coding-plan";
export const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_PLAN_API_KEY_ENV = "ZAI_API_KEY";

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

export const ZAI_CODING_PLAN_MODELS = [
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200000,
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

export default function zaiCodingPlan(pi: ExtensionAPI): void {
	registerZaiCodingPlan(pi);
}
