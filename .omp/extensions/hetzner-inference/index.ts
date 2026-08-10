import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

const BASE_URL = "https://inference.hetzner.com/api/v1";

function model(id: string, contextWindow: number): ProviderModelConfig {
	return {
		id,
		name: id.slice(id.lastIndexOf("/") + 1),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 32_768,
	};
}

// ponytail: OMP 17.2.12's /model omits dynamic extension models; restore live discovery when fixed.
const MODELS = [
	model("DeepSeek-V4-Flash-0731", 512_000),
	model("GLM-5.2-NVFP4", 512_000),
	model("Kimi-K2.7-Code", 262_144),
	model("Qwen/Qwen3.6-35B-A3B-FP8", 262_144),
];

export default function hetznerInference(pi: ExtensionAPI): void {
	pi.registerProvider("hetzner", {
		baseUrl: BASE_URL,
		apiKey: "HETZNER_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models: MODELS,
	});
}
