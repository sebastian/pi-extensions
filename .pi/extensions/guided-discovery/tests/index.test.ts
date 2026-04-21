import test from "node:test";
import assert from "node:assert/strict";
import { buildImplementationPrompt, isRedundantImplementationKickoffQuestionnaire } from "../implementation-prompt.ts";
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

test("implementation prompt explicitly says approval is already granted", () => {
	const prompt = buildImplementationPrompt({ extraInstructions: "Keep it minimal.", planPath: "/repo/PLAN.md" });

	assert.match(prompt, /Implementation is already approved\./);
	assert.match(prompt, /Do not ask whether you should implement/);
	assert.match(prompt, /do not use questionnaire for implementation-mode confirmations, status pings, or no-op acknowledgements/i);
	assert.match(prompt, /Only ask a question before coding if there is a concrete blocking ambiguity/);
});

test("kickoff questionnaire filter catches redundant implementation approval prompts", () => {
	assert.equal(
		isRedundantImplementationKickoffQuestionnaire({
			questions: [
				{
					id: "implementation-mode",
					label: "Implementation mode",
					prompt: "Proceed with implementation now?",
					options: [{ label: "Proceed with implementation now", value: "yes" }],
				},
			],
		}),
		true,
	);

	assert.equal(
		isRedundantImplementationKickoffQuestionnaire({
			questions: [
				{
					id: "plan-source",
					prompt: "Use the approved plan as the sole source of truth for this change?",
					options: [
						{ label: "Yes", value: "yes" },
						{ label: "No", value: "no" },
					],
				},
			],
		}),
		true,
	);

	assert.equal(
		isRedundantImplementationKickoffQuestionnaire({
			questions: [{ id: "status2", prompt: "Working...", options: [{ label: "OK", value: "ok" }] }],
		}),
		true,
	);
});

test("kickoff questionnaire filter allows real post-review fix decisions", () => {
	assert.equal(
		isRedundantImplementationKickoffQuestionnaire({
			questions: [
				{
					id: "finding-1",
					label: "Remaining finding",
					prompt: "A review found a missing empty-state test. What should I do?",
					options: [
						{ label: "Fix now", value: "fix" },
						{ label: "Defer", value: "defer" },
						{ label: "Ignore", value: "ignore" },
					],
				},
			],
		}),
		false,
	);
});
