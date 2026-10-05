import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { QueueAction, QueueState } from "../work-queue.ts";

const piDir = process.env.PI_TEST_CODING_AGENT;
const STATE = "toolbox-work-queue-v1";
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for orchestration");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("native Pi opt-in, busy-supervisor ordering, completion, off and reload recovery", { skip: !piDir, timeout: 30_000 }, async () => {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piDir!, "dist/index.js")).href);
	const { InMemoryCredentialStore, InMemoryModelsStore } = await import(pathToFileURL(join(piDir!, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "pi-orchestration-test-"));
	const previousArgv1 = process.argv[1];
	let session;
	let second;
	let supervisorGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
	const extensionErrors: unknown[] = [];
	try {
		const fakePi = join(dir, "fake-pi.mjs");
		await writeFile(fakePi, `
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const name = process.argv[process.argv.indexOf("--name") + 1];
const validating = name.startsWith("validate");
const id = Number(name.match(/task (\\d+)/)[1]);
const raw = process.argv.at(-1);
const task = JSON.parse(raw.slice(raw.indexOf("{")));
if (process.env.PI_ORCHESTRATION_CHILD !== "1") throw new Error("Missing child isolation marker");
appendFileSync("trace.jsonl", JSON.stringify({ id, validating, task }) + "\\n");
while (!validating && !existsSync("release-" + id)) await setTimeout(10);
const text = validating ? JSON.stringify({ checks: task.acceptance.map((_, index) => ({ criterion: index + 1, passed: true, evidence: "Independent check passed" })) }) : "Implemented " + task.title;
const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.1 } } };
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "agent_end", messages: [message] }));
`, "utf8");
		process.argv[1] = fakePi;
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerProvider("orchestration-test", {
			api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "test",
			models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
		async function create(manager = SessionManager.inMemory(dir)) {
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
			const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [fileURLToPath(new URL("../orchestration.ts", import.meta.url))] });
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: modelRuntime.getModel("orchestration-test", "test"), resourceLoader, settingsManager, sessionManager: manager });
			await session.bindExtensions({ mode: "rpc", onError: (error: unknown) => extensionErrors.push(error) });
			return session;
		}
		session = await create();
		const originalTools = session.getActiveToolNames();
		assert.ok(originalTools.includes("write"));
		assert.ok(!originalTools.includes("work_queue"));
		assert.equal(session.sessionManager.getBranch().some((entry) => entry.customType === STATE), false);
		let nextAction: QueueAction | undefined;
		const payloads: string[] = [];
		let callId = 0;
		session.agent.streamFunction = (model, context, options) => modelRuntime.streamSimple(model, context, {
			...options,
			fetch: async (_url, init) => {
				payloads.push(init.body);
				if (supervisorGate) await supervisorGate.promise;
				const action = nextAction;
				nextAction = undefined;
				const delta = action
					? { role: "assistant", tool_calls: [{ index: 0, id: `call-${++callId}`, type: "function", function: { name: "work_queue", arguments: JSON.stringify(action) } }] }
					: { role: "assistant", content: "Plan updated" };
				const chunk = { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: action ? "tool_calls" : "stop" }] };
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const state = (): QueueState => session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE).at(-1).data;
		const trace = async () => {
			try { return (await readFile(join(dir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
			catch (error) { if (error.code === "ENOENT") return []; throw error; }
		};
		await session.prompt("Normal conversation");
		assert.equal(payloads.at(-1)!.includes("conversational supervisor"), false);
		await session.prompt("/orchestrate");
		assert.equal(state().enabled, true);
		assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "read", "work_queue"]);
		await session.prompt("/orchestrate");
		assert.equal(state().enabled, true, "bare /orchestrate enables rather than toggles");
		assert.deepEqual(state().previousTools, originalTools, "repeated activation preserves normal tools");
		await session.prompt("/orchestrate pause");
		for (const title of ["A", "B", "C"]) {
			nextAction = { action: "add", title, request: `Implement ${title}`, acceptance: ["Check passes"] };
			await session.prompt(`Add task ${title}`);
		}
		assert.equal((await trace()).length, 0);
		assert.ok(payloads.at(-1)!.includes("conversational supervisor"));
		await session.prompt("/orchestrate start");
		await until(async () => (await trace()).length === 1);
		supervisorGate = Promise.withResolvers<void>();
		nextAction = { action: "reorder", order: [3, 2] };
		const before = payloads.length;
		const reorganizing = session.prompt("Move C before B; don't interrupt A");
		await until(() => payloads.length > before);
		await writeFile(join(dir, "release-1"), "");
		await until(() => state().tasks.find((task) => task.id === 1)?.status === "done");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual((await trace()).map((entry) => [entry.id, entry.validating]), [[1, false], [1, true]], "no stale-order dispatch while the supervisor is busy");
		supervisorGate.resolve();
		supervisorGate = undefined;
		await reorganizing;
		await until(async () => (await trace()).length === 3);
		assert.equal((await trace())[2].id, 3);
		assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "work-queue-result"), "completion notice appears without another user message");
		assert.equal(state().tasks.find((task) => task.id === 1)!.cost, 0.2);
		await session.prompt("/orchestrate pause");
		const saves = () => session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE).length;
		const previousSaves = saves();
		await session.prompt("/orchestrate cancel 3");
		await until(() => saves() >= previousSaves + 2);
		await session.prompt("/orchestrate off");
		assert.equal(state().enabled, false);
		assert.deepEqual(session.getActiveToolNames(), originalTools);
		await session.prompt("Normal work again");
		assert.equal(JSON.parse(payloads.at(-1)!).messages[0].content.includes("conversational supervisor"), false);

		await session.prompt("/orchestrate on");
		assert.equal(state().paused, true, "existing queues require explicit start");
		await session.prompt("/orchestrate start");
		await until(async () => (await trace()).length === 4);
		await session.reload();
		assert.equal(state().enabled, true);
		assert.equal(state().paused, true);
		assert.equal(state().tasks.find((task) => task.id === 2)!.status, "blocked");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal((await trace()).length, 4, "reload cannot silently replay interrupted work");
		second = await create();
		assert.deepEqual(second.getActiveToolNames(), originalTools, "a separate session does not inherit supervisor mode");
		assert.equal(second.sessionManager.getBranch().some((entry) => entry.customType === STATE), false);
		assert.deepEqual(extensionErrors, []);
	} finally {
		supervisorGate?.resolve();
		await session?.abort();
		await session?.reload();
		session?.dispose();
		second?.dispose();
		process.argv[1] = previousArgv1;
		await rm(dir, { recursive: true, force: true });
	}
});

test("child watchdog terminates Pi when the supervisor's IPC channel disappears", { skip: !piDir, timeout: 20_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-orchestration-watchdog-"));
	const script = join(dir, "child.mjs");
	const sdk = pathToFileURL(join(piDir!, "dist/index.js")).href;
	const ai = pathToFileURL(join(piDir!, "node_modules/@earendil-works/pi-ai/dist/index.js")).href;
	const extension = fileURLToPath(new URL("../orchestration.ts", import.meta.url));
	await writeFile(script, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync("terminated", "SIGTERM"); process.exit(0); });
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(${JSON.stringify(sdk)});
const { InMemoryCredentialStore, InMemoryModelsStore } = await import(${JSON.stringify(ai)});
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("watchdog-test", { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "test", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const cwd = process.cwd();
const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [${JSON.stringify(extension)}] });
await resourceLoader.reload();
if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel("watchdog-test", "test"), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: true });
await session.bindExtensions({ mode: "json" });
console.log("ready");
setInterval(() => {}, 1000); // Simulate a worker with an active model/tool operation.
`, "utf8");
	const child = spawn(process.execPath, [script], { cwd: dir, env: { ...process.env, PI_ORCHESTRATION_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const exit = Promise.withResolvers<number | null>();
	let output = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.on("error", exit.reject);
	child.on("exit", exit.resolve);
	try {
		await until(() => { if (child.exitCode !== null) throw new Error(stderr || "Child exited before ready"); return output.includes("ready"); });
		child.disconnect();
		await until(() => child.exitCode !== null);
		assert.equal(await exit.promise, 0);
		assert.equal(await readFile(join(dir, "terminated"), "utf8"), "SIGTERM");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exit.promise;
		child.stdout.destroy();
		child.stderr.destroy();
		await rm(dir, { recursive: true, force: true });
	}
});
