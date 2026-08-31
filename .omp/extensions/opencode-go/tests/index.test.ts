import assert from "node:assert/strict";
import test from "node:test";
import opencodeGo from "../index.ts";

test("uses OPENCODE_GO_API_KEY for OMP's built-in OpenCode Go models", () => {
	let registration: { name: string; config: unknown } | undefined;
	opencodeGo({
		registerProvider(name: string, config: unknown) {
			registration = { name, config };
		},
	} as never);

	assert.deepEqual(registration, {
		name: "opencode-go",
		config: { apiKey: "OPENCODE_GO_API_KEY" },
	});
});
