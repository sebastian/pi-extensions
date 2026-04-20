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

const GLM_51_REIN_IN_PROMPT = [
	"- Be concise, direct, and matter-of-fact.",
	"- Do not be flattering, sycophantic, or overly eager to please.",
	"- Avoid unnecessary praise, reassurance, or agreement.",
	"- Keep preambles short and skip filler.",
	"- State uncertainty briefly when needed, then continue with the best grounded answer.",
].join("\n");

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

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.provider !== ZAI_CODING_PLAN_PROVIDER_ID || ctx.model.id !== "glm-5.1") {
			return undefined;
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${GLM_51_REIN_IN_PROMPT}`
				: GLM_51_REIN_IN_PROMPT,
		};
	});
}
