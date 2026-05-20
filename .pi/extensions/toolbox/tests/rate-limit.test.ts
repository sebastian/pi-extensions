import test from "node:test";
import assert from "node:assert/strict";
import registerRateLimitHandling, { extractRateLimitInfo, formatRateLimitMessage } from "../rate-limit.ts";

function googleRateLimitError(retryText = "Please retry in 29.334660237s."): string {
	const inner = {
		error: {
			code: 429,
			message: `You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash\n${retryText}`,
			status: "RESOURCE_EXHAUSTED",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.Help",
					links: [{ description: "Learn more about Gemini API quotas", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }],
				},
				{
					"@type": "type.googleapis.com/google.rpc.QuotaFailure",
					violations: [
						{
							quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
							quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
							quotaDimensions: { location: "global", model: "gemini-3.5-flash" },
							quotaValue: "5",
						},
					],
				},
				{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "29s" },
			],
		},
	};
	return JSON.stringify({ error: { message: JSON.stringify(inner, null, 2), code: 429, status: "Too Many Requests" } });
}

test("extracts nested Google rate-limit details", () => {
	const info = extractRateLimitInfo(googleRateLimitError());

	assert.ok(info);
	assert.equal(info.provider, "google");
	assert.equal(info.code, 429);
	assert.equal(info.status, "RESOURCE_EXHAUSTED");
	assert.equal(info.model, "gemini-3.5-flash");
	assert.equal(info.quotaMetric, "generativelanguage.googleapis.com/generate_content_free_tier_requests");
	assert.equal(info.quotaValue, "5");
	assert.equal(info.retryAfterSeconds, 29.334660237);
});

test("formats Google rate limits as concise user-facing messages", () => {
	const info = extractRateLimitInfo(googleRateLimitError())!;
	const message = formatRateLimitMessage(info);

	assert.match(message, /^Gemini rate limit hit for gemini-3\.5-flash \(429\)\./);
	assert.match(message, /Quota: generate content free tier requests \(limit 5\)\./);
	assert.match(message, /Retry after about 30s\./);
	assert.match(message, /Usage: https:\/\/ai\.dev\/rate-limit/);
	assert.match(message, /Docs: https:\/\/ai\.google\.dev\/gemini-api\/docs\/rate-limits/);
	assert.equal(message.includes('"error"'), false);
});

test("message_end handler rewrites ugly provider JSON errors", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	registerRateLimitHandling(pi as never);

	const originalMessage = {
		role: "assistant",
		stopReason: "error",
		errorMessage: googleRateLimitError(),
		provider: "google",
		model: "gemini-3.5-flash",
		content: [],
	};
	const result = await handlers.get("message_end")![0]({ message: originalMessage });

	assert.ok(result?.message);
	assert.equal(result.message.provider, "google");
	assert.match(result.message.errorMessage, /Gemini rate limit hit for gemini-3\.5-flash/);
	assert.equal(result.message.errorMessage.includes("RESOURCE_EXHAUSTED"), false);
});

test("ignores unrelated provider errors", () => {
	assert.equal(extractRateLimitInfo("Authentication failed: invalid API key"), undefined);
});
