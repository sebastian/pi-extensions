import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Server } from "bun";
import { handleClefRequest, MAX_BODY_BYTES } from "./transport.ts";

let server: Server<undefined> | undefined;

export default function cloudflareClef(pi: ExtensionAPI): void {
	if (!server) {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: MAX_BODY_BYTES,
			fetch: request => handleClefRequest(request),
		});
		// Child sessions share this module; none owns the listener's lifetime.
		server.unref();
	}

	pi.registerProvider("cloudflare-workers-ai", {
		baseUrl: `http://127.0.0.1:${server.port}`,
		apiKey: "CLOUDFLARE_WORKERS_AI_API_KEY",
		api: "typesafe",
		models: [{
			id: "clef",
			name: "Cloudflare Clef",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.24, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536,
			maxTokens: 0,
		}],
	});
}
