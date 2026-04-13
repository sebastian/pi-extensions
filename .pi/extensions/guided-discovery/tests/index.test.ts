import test from "node:test";
import assert from "node:assert/strict";
import { supportsStructuredImplementationWidget } from "../widget-support.ts";

test("structured implementation widget falls back to string widgets in RPC mode", () => {
	assert.equal(
		supportsStructuredImplementationWidget({ hasUI: true }, ["node", "pi", "--mode", "rpc"]),
		false,
	);
	assert.equal(
		supportsStructuredImplementationWidget({ hasUI: true }, ["node", "pi", "--mode=rpc"]),
		false,
	);
	assert.equal(
		supportsStructuredImplementationWidget({ hasUI: true }, ["node", "pi", "--mode", "rpc", "--mode", "text"]),
		true,
	);
	assert.equal(supportsStructuredImplementationWidget({ hasUI: true }, ["node", "pi"]), true);
	assert.equal(supportsStructuredImplementationWidget({ hasUI: false }, ["node", "pi"]), false);
});
