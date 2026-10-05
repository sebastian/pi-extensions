import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { SubagentEvent, SubagentRunResult } from "../subagent-runner.ts";
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

test("buildSubagentArgs treats dash-prefixed prompts as input, not CLI options", () => {
	const args = buildSubagentArgs({ cwd: "/repo", systemPrompt: "", prompt: "--review this change" });
	assert.deepEqual(args.slice(-2), ["--", "--review this change"]);
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
		model: "zai/glm-5.2",
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
	assert.ok(args.includes("zai/glm-5.2"));
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

test("workers can retain skills without implicitly granting project trust", () => {
	const args = buildSubagentArgs({ cwd: "/repo", systemPrompt: "", prompt: "task", loadSkills: true, approveProject: false });
	assert.ok(!args.includes("--no-skills"));
	assert.ok(args.includes("--no-approve"));
	assert.ok(!args.includes("--approve"));
});

test("runSubagent rejects pre-aborted work without spawning", async () => {
	await assert.rejects(runSubagent({ cwd: "/missing-directory", systemPrompt: "", prompt: "task", signal: AbortSignal.abort(new Error("already aborted")) }), /already aborted/);
});

test("runSubagent escalates ignored SIGTERM and releases its abort listener", { timeout: 12_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-subagent-cancel-"));
	const previousArgv1 = process.argv[1];
	const controller = new AbortController();
	let pid: number | undefined;
	try {
		const fakePi = join(root, "fake-pi.mjs");
		await writeFile(fakePi, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log(JSON.stringify({ type: "tool_execution_start", toolName: "ready", args: { pid: process.pid } }));\n');
		process.argv[1] = fakePi;
		await assert.rejects(runSubagent({
			cwd: root, systemPrompt: "", prompt: "task", signal: controller.signal,
			onEvent: (event) => { if (event.type === "tool") { pid = (event.args as { pid: number }).pid; controller.abort(); } },
		}), /aborted/);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
		process.argv[1] = previousArgv1;
		await rm(root, { recursive: true, force: true });
	}
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
		const controller = new AbortController();
		const result = await runSubagent({
			cwd: root,
			systemPrompt: "",
			prompt: "ignored",
			signal: controller.signal,
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
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		process.argv[1] = previousArgv1;
		await rm(root, { recursive: true, force: true });
	}
});

test("live child callbacks distinguish deltas/block/final snapshots and turns, decode split UTF-8 and omit reasoning", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-subagent-stream-"));
	const previousArgv1 = process.argv[1];
	const controller = new AbortController();
	const events: SubagentEvent[] = [];
	let running: Promise<SubagentRunResult> | undefined;
	let settled = false;
	try {
		const fakePi = join(root, "fake-pi.mjs");
		await writeFile(fakePi, `
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const emit = (event) => console.log(JSON.stringify(event));
const message = (text) => ({ role: "assistant", content: text ? [{ type: "text", text }, { type: "thinking", thinking: "SECRET" }] : [], stopReason: "stop" });
emit({ type: "message_start", message: message("") });
emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "SECRET" } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Checking ", partial: message("Checking ") } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message("Checking ") } });
const wire = Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "界" } }) + "\\n");
const split = wire.indexOf(Buffer.from("界")) + 1;
process.stdout.write(wire.subarray(0, split));
await setTimeout(20);
process.stdout.write(wire.subarray(split));
emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Checking 界" } });
emit({ type: "auto_retry_start", attempt: 2, errorMessage: "provider delay" });
emit({ type: "tool_execution_start", toolName: "ready" });
while (!existsSync("release")) await setTimeout(10);
const first = message("Checking 界");
emit({ type: "message_end", message: first });
emit({ type: "agent_end", messages: [first] });
emit({ type: "message_start", message: message("") });
const second = message("Checking 界");
emit({ type: "message_end", message: second });
emit({ type: "message_end", message: message("") });
emit({ type: "agent_end", messages: [second, message("")] });
`, "utf8");
		process.argv[1] = fakePi;
		running = runSubagent({ cwd: root, systemPrompt: "", prompt: "ignored", signal: controller.signal, onEvent: (event) => events.push(event) });
		void running.then(() => { settled = true; }, () => { settled = true; });
		const deadline = Date.now() + 5000;
		while (!events.some((event) => event.toolName === "ready")) {
			assert.ok(Date.now() < deadline && !settled, "live feedback before child completion");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(settled, false);
		assert.deepEqual(events.filter((event) => event.textMode === "delta").map((event) => event.message), ["Checking ", "界"]);
		assert.deepEqual(events.filter((event) => event.textMode === "snapshot").map((event) => [event.message, event.messageId, event.contentIndex]), [["Checking ", 1, 0], ["Checking 界", 1, 0]]);
		assert.ok(events.some((event) => event.type === "status" && event.message === "Retry 2: provider delay"));
		assert.ok(events.some((event) => event.type === "thinking" && event.message === undefined));
		await writeFile(join(root, "release"), "");
		const result = await running;
		assert.equal(result.assistantText, "Checking 界");
		assert.deepEqual(events.filter((event) => event.type === "status" && event.textMode === "snapshot").map((event) => event.messageId), [1, 2], "empty final assistant must not relabel/repeat older text as a new turn");
		assert.ok(!JSON.stringify(events).includes("SECRET"));
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		controller.abort();
		await running?.catch(() => {});
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
