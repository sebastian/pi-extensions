import assert from "node:assert/strict";
import test from "node:test";
import { handleClefRequest, MAX_BODY_BYTES } from "../transport.ts";

function request(account = "0123456789abcdef0123456789abcdef", body = JSON.stringify({
	model: "clef",
	state: "Checkout is unavailable.",
	questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
})): Request {
	return new Request("http://127.0.0.1/v1/systemone", {
		method: "POST",
		headers: { Authorization: "Bearer test-only-key", "X-Cloudflare-Account-Id": account },
		body,
	});
}

test("returns native judgments and fails closed at the Cloudflare boundary", async () => {
	const result = {
		model: "clef",
		answers: { urgent: { type: "noul", noul: 0.95 } },
		usage: { input_tokens: 17, output_tokens: 0 },
	};
	const success = await handleClefRequest(request(), async () => Response.json({ success: true, result, errors: [] }));
	assert.equal(success.status, 200);
	const judgment = await success.json();
	assert.equal(judgment.model, "clef");
	assert.equal(judgment.answers.urgent.type, "noul");
	assert.equal(judgment.answers.urgent.noul, 0.95);
	assert.equal(judgment.usage.input_tokens, 17);
	assert.equal(judgment.usage.output_tokens, 0);

	for (const envelope of [
		{ success: false, errors: [{ message: "test-only-key" }] },
		{ success: true, result, errors: [{ message: "test-only-key" }] },
		{ success: true, result: { model: "clef", answers: {} }, errors: [] },
	]) {
		const failed = await handleClefRequest(request(), async () => Response.json(envelope));
		assert.equal(failed.status, 502);
		assert.equal((await failed.text()).includes("test-only-key"), false);
	}

	const limited = await handleClefRequest(request(), async () => new Response("test-only-key", {
		status: 429,
		headers: { "Retry-After": "2" },
	}));
	assert.equal(limited.status, 429);
	assert.equal(limited.headers.get("Retry-After"), "2");
	assert.equal((await limited.text()).includes("test-only-key"), false);

	let fetched = false;
	const unexpectedFetch: typeof fetch = async () => {
		fetched = true;
		throw new Error("Invalid local requests must not send credentials");
	};
	assert.equal((await handleClefRequest(request("../other-account"), unexpectedFetch)).status, 400);
	assert.equal((await handleClefRequest(request(undefined, " ".repeat(MAX_BODY_BYTES + 1)), unexpectedFetch)).status, 413);
	assert.equal(fetched, false);
});
