export const MAX_BODY_BYTES = 13 * 1024 * 1024;

function failure(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json({ error: message }, { status, headers });
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function handleClefRequest(request: Request, fetchUpstream: typeof fetch = fetch): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname !== "/v1/systemone" || url.search) return failure(404, "Not found");
	if (request.method !== "POST") return failure(405, "Use POST", { Allow: "POST" });

	const account = request.headers.get("X-Cloudflare-Account-Id");
	if (!account || !/^[a-f\d]{32}$/i.test(account)) {
		return failure(400, "X-Cloudflare-Account-Id must be a 32-character hexadecimal account ID");
	}
	const authorization = request.headers.get("Authorization");
	if (!authorization || !/^Bearer \S+$/i.test(authorization)) return failure(401, "A bearer API key is required");

	let bytes = 0;
	let payload: unknown;
	let rawBody: string;
	try {
		request.signal.throwIfAborted();
		const body = request.body?.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					bytes += chunk.byteLength;
					if (bytes > MAX_BODY_BYTES) throw new Error("Request body too large");
					controller.enqueue(chunk);
				},
			}),
			{ signal: request.signal },
		);
		rawBody = await new Response(body).text();
		payload = JSON.parse(rawBody);
	} catch {
		if (request.signal.aborted) return failure(499, "Judgment request cancelled");
		return bytes > MAX_BODY_BYTES
			? failure(413, "Judgment request exceeds 13 MiB")
			: failure(400, "Judgment request must be valid JSON");
	}
	if (
		typeof payload !== "object" || payload === null ||
		!("model" in payload) || payload.model !== "clef" || !("state" in payload) ||
		!("questions" in payload) || typeof payload.questions !== "object" ||
		payload.questions === null || Array.isArray(payload.questions)
	) {
		return failure(400, "Expected model clef, state, and a questions object");
	}
	const body = new TextEncoder().encode(rawBody);
	if (body.byteLength > MAX_BODY_BYTES) return failure(413, "Judgment request exceeds 13 MiB");

	try {
		const upstream = await fetchUpstream(
			`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`,
			{
				method: "POST",
				headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
				body,
				signal: request.signal,
				redirect: "manual",
			},
		);
		if (!upstream.ok) {
			await upstream.body?.cancel().catch(() => {});
			const headers = new Headers();
			const retryAfter = upstream.headers.get("Retry-After");
			if (retryAfter) headers.set("Retry-After", retryAfter);
			// Do not expose upstream error bodies or follow redirects carrying credentials.
			return upstream.status === 304
				? new Response(null, { status: 304, headers })
				: failure(upstream.status, `Cloudflare Workers AI returned HTTP ${upstream.status}`, headers);
		}
		const envelope: unknown = await upstream.json();
		if (
			typeof envelope !== "object" || envelope === null ||
			!("success" in envelope) || envelope.success !== true ||
			!("errors" in envelope) || !Array.isArray(envelope.errors) || envelope.errors.length !== 0 ||
			!("result" in envelope)
		) {
			return failure(502, "Cloudflare Workers AI returned an unsuccessful or invalid envelope");
		}
		const result = envelope.result;
		if (
			typeof result !== "object" || result === null ||
			!("model" in result) || result.model !== "clef" ||
			!("answers" in result) || typeof result.answers !== "object" ||
			result.answers === null || Array.isArray(result.answers) ||
			!("usage" in result) || typeof result.usage !== "object" || result.usage === null ||
			!("input_tokens" in result.usage) || !isTokenCount(result.usage.input_tokens) ||
			!("output_tokens" in result.usage) || !isTokenCount(result.usage.output_tokens)
		) {
			return failure(502, "Cloudflare Workers AI returned an invalid judgment result");
		}
		return Response.json({ model: result.model, answers: result.answers, usage: result.usage });
	} catch {
		return request.signal.aborted
			? failure(499, "Judgment request cancelled")
			: failure(502, "Cloudflare Workers AI request failed or returned invalid JSON");
	}
}
