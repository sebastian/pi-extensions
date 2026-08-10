import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

const BASE_URL = "https://inference.hetzner.com/api/v1";

function parseModel(value: unknown): ProviderModelConfig {
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("max_model_len" in value) ||
		typeof value.max_model_len !== "number" ||
		!Number.isSafeInteger(value.max_model_len) ||
		value.max_model_len <= 0
	) {
		throw new Error("Hetzner returned invalid model metadata");
	}

	return {
		id: value.id,
		name: value.id.slice(value.id.lastIndexOf("/") + 1),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: value.max_model_len,
		// ponytail: cap unknown output limits at 32K; use provider metadata if Hetzner adds it.
		maxTokens: Math.min(value.max_model_len, 32_768),
	};
}

async function fetchModels(
	apiKey: string | undefined,
): Promise<readonly ProviderModelConfig[]> {
	if (!apiKey) throw new Error("HETZNER_API_KEY is required");

	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		throw new Error(`Hetzner model discovery failed: HTTP ${response.status}`);
	}

	const payload: unknown = await response.json();
	if (
		!payload ||
		typeof payload !== "object" ||
		!("data" in payload) ||
		!Array.isArray(payload.data)
	) {
		throw new Error("Hetzner returned an invalid model list");
	}
	return payload.data.map(parseModel);
}

export default function hetznerInference(pi: ExtensionAPI): void {
	pi.registerProvider("hetzner", {
		baseUrl: BASE_URL,
		apiKey: "HETZNER_API_KEY",
		api: "openai-completions",
		authHeader: true,
		fetchDynamicModels: fetchModels,
	});
}
