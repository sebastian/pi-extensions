import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSubagentArgs, discoverProjectExtensionPaths, runSubagent } from "../subagent-runner.ts";

test("buildSubagentArgs disables extension discovery by default", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		systemPrompt: "System",
		prompt: "Review this change",
		tools: ["read", "find"],
	});

	assert.ok(args.includes("--no-extensions"));
	assert.deepEqual(args.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--no-extensions"]);
	assert.ok(!args.includes("-e"));
});

test("buildSubagentArgs can name JSON-mode startup sessions", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		name: "review openai/gpt-5.4",
		systemPrompt: "System",
		prompt: "Review this change",
	});

	const nameIndex = args.indexOf("--name");
	assert.notEqual(nameIndex, -1);
	assert.equal(args[nameIndex + 1], "review openai/gpt-5.4");
});

test("buildSubagentArgs can keep normal extensions enabled and add explicit extension sources", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		systemPrompt: "System",
		prompt: "Review this change",
		model: "zai-coding-plan/glm-5.1",
		loadExtensions: true,
		extensions: ["/repo/.pi/extensions/zai-coding-plan", "/repo/.pi/extensions/toolbox"],
	});

	assert.ok(!args.includes("--no-extensions"));
	const extensionArgs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-e") extensionArgs.push(args[index + 1] ?? "");
	}
	assert.deepEqual(extensionArgs, [resolve("/repo/.pi/extensions/zai-coding-plan"), resolve("/repo/.pi/extensions/toolbox")]);
	assert.ok(args.includes("--model"));
	assert.ok(args.includes("zai-coding-plan/glm-5.1"));
});

test("buildSubagentArgs can approve trusted project-local inputs for non-interactive subagents", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		systemPrompt: "System",
		prompt: "Review this change",
		loadExtensions: true,
		approveProject: true,
	});

	assert.ok(args.includes("--approve"));
	assert.ok(!args.includes("--no-extensions"));
});

test("runSubagent treats retrying agent_end events as non-final", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-subagent-runner-retry-"));
	const previousArgv1 = process.argv[1];
	try {
		const fakePi = join(root, "fake-pi.mjs");
		await writeFile(
			fakePi,
			[
				"const transient = { role: 'assistant', content: [{ type: 'text', text: 'transient failure' }], stopReason: 'error', errorMessage: '429 retry', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 } } };",
				"const final = { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop', usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.02 } } };",
				"for (const event of [",
				"  { type: 'message_end', message: transient },",
				"  { type: 'agent_end', messages: [transient], willRetry: true },",
				"  { type: 'message_end', message: final },",
				"  { type: 'agent_end', messages: [final], willRetry: false },",
				"]) console.log(JSON.stringify(event));",
				"",
			].join("\n"),
			"utf8",
		);

		process.argv[1] = fakePi;
		const events: Array<{ type: string; message?: string }> = [];
		const result = await runSubagent({
			cwd: root,
			systemPrompt: "",
			prompt: "ignored",
			onEvent: (event) => events.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.assistantText, "final answer");
		assert.deepEqual(result.messages.map((message) => message.role), ["assistant"]);
		assert.deepEqual(
			events.filter((event) => event.type === "status").map((event) => event.message),
			["final answer"],
		);
		assert.equal(result.usage.turns, 2);
		assert.equal(result.usage.totalTokens, 7);
	} finally {
		process.argv[1] = previousArgv1;
		await rm(root, { recursive: true, force: true });
	}
});

test("discoverProjectExtensionPaths finds package directories and standalone extension files", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-subagent-runner-"));
	try {
		const extensionsRoot = join(root, ".pi", "extensions");
		await mkdir(join(extensionsRoot, "package-extension"), { recursive: true });
		await mkdir(join(extensionsRoot, "index-extension"), { recursive: true });
		await writeFile(join(extensionsRoot, "package-extension", "package.json"), "{}\n", "utf8");
		await writeFile(join(extensionsRoot, "index-extension", "index.ts"), "export default {};\n", "utf8");
		await writeFile(join(extensionsRoot, "standalone.ts"), "export default {};\n", "utf8");
		await writeFile(join(extensionsRoot, "notes.md"), "not an extension\n", "utf8");

		const extensionPaths = await discoverProjectExtensionPaths(root);
		assert.deepEqual(extensionPaths, [
			join(extensionsRoot, "index-extension", "index.ts"),
			join(extensionsRoot, "package-extension"),
			join(extensionsRoot, "standalone.ts"),
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
