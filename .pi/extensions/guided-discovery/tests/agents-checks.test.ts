import test from "node:test";
import assert from "node:assert/strict";
import {
	appendAgentsChecksToCheckerReport,
	collectAgentsCheckCommands,
	extractAgentsCheckCommands,
	runAgentsCheckCommands,
} from "../agents-checks.ts";
import type { RelevantGuidanceDocument } from "../guidance.ts";

test("extractAgentsCheckCommands recognizes explicit checks and fenced commands in relevant sections", () => {
	const commands = extractAgentsCheckCommands(
		[
			"# AGENTS",
			"",
			"## Checks",
			"",
			"- Run: npm test",
			"- Command: `pnpm lint`",
			"",
			"## Before finishing",
			"",
			"```sh",
			"jj status",
			"pnpm typecheck",
			"```",
		].join("\n"),
		"AGENTS.md",
	);

	assert.deepEqual(commands, [
		{ command: "npm test", source: "AGENTS.md" },
		{ command: "pnpm lint", source: "AGENTS.md" },
		{ command: "jj status", source: "AGENTS.md" },
		{ command: "pnpm typecheck", source: "AGENTS.md" },
	]);
});

test("extractAgentsCheckCommands ignores inline backticks and non-shell fences", () => {
	const commands = extractAgentsCheckCommands(
		[
			"# AGENTS",
			"",
			"## Checks",
			"",
			"Mention `npm test` in prose, but do not run it.",
			"```ts",
			"console.log('npm test')",
			"```",
		].join("\n"),
		"AGENTS.md",
	);

	assert.deepEqual(commands, []);
});

test("collectAgentsCheckCommands deduplicates repeated commands across documents and preserves provenance", () => {
	const documents: RelevantGuidanceDocument[] = [
		{
			path: "/repo/AGENTS.md",
			relativePath: "AGENTS.md",
			content: "## Checks\n- Run: npm test\n- Run: npm test",
			appliesTo: ["src/index.ts"],
		},
		{
			path: "/repo/src/AGENTS.md",
			relativePath: "src/AGENTS.md",
			content: "## Validation\n- Run: npm test\n- Command: pnpm lint",
			appliesTo: ["src/index.ts"],
		},
	];

	assert.deepEqual(collectAgentsCheckCommands(documents), [
		{ command: "npm test", source: "AGENTS.md, src/AGENTS.md" },
		{ command: "pnpm lint", source: "src/AGENTS.md" },
	]);
});

test("runAgentsCheckCommands executes simple argv commands without invoking a shell", async () => {
	const seen: Array<{ command: string; args: string[] }> = [];
	const runs = await runAgentsCheckCommands({
		cwd: "/repo",
		exec: async (command, args) => {
			seen.push({ command, args });
			if (command === "echo" && args.join(" ") === "ok") {
				return { stdout: "ok\n", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "failed\n", code: 1 };
		},
		commands: [
			{ command: "echo ok", source: "AGENTS.md" },
			{ command: "npm test", source: "src/AGENTS.md" },
		],
	});

	assert.deepEqual(seen, [
		{ command: "echo", args: ["ok"] },
		{ command: "npm", args: ["test"] },
	]);
	assert.deepEqual(
		runs.map((run) => ({ command: run.command, status: run.status, source: run.source })),
		[
			{ command: "echo ok", status: "passed", source: "AGENTS.md" },
			{ command: "npm test", status: "failed", source: "src/AGENTS.md" },
		],
	);

	const report = appendAgentsChecksToCheckerReport(
		{
			findings: [],
			checksRun: [],
			unresolvedRisks: [],
			overallAssessment: "Looks good",
		},
		runs,
	);

	assert.equal(report.findings.length, 1);
	assert.match(report.findings[0]?.summary ?? "", /Required AGENTS\.md check failed/);
	assert.equal(report.checksRun.length, 2);
});

test("runAgentsCheckCommands blocks unapproved commands and surfaces them as unresolved risks", async () => {
	const runs = await runAgentsCheckCommands({
		cwd: "/repo",
		exec: async () => {
			throw new Error("should not execute");
		},
		commands: [{ command: "npm test", source: "AGENTS.md" }],
		policy: {
			allowed: false,
			reason: "Explicit approval was not granted.",
		},
	});

	assert.deepEqual(runs.map((run) => ({ command: run.command, status: run.status, summary: run.summary })), [
		{ command: "npm test", status: "blocked", summary: "Explicit approval was not granted." },
	]);

	const report = appendAgentsChecksToCheckerReport(
		{
			findings: [],
			checksRun: [],
			unresolvedRisks: [],
			overallAssessment: "Looks good",
		},
		runs,
	);

	assert.equal(report.findings.length, 0);
	assert.equal(report.unresolvedRisks.length, 1);
	assert.match(report.unresolvedRisks[0] ?? "", /not executed/);
});

test("runAgentsCheckCommands blocks shell-style commands even after approval", async () => {
	const runs = await runAgentsCheckCommands({
		cwd: "/repo",
		exec: async () => {
			throw new Error("should not execute");
		},
		commands: [{ command: "npm test && npm run lint", source: "AGENTS.md" }],
		policy: { allowed: true },
	});

	assert.deepEqual(runs.map((run) => ({ status: run.status, summary: run.summary })), [
		{
			status: "blocked",
			summary: "Only simple argv-style commands are allowed. Remove shell operators or environment assignments from AGENTS.md.",
		},
	]);
});
