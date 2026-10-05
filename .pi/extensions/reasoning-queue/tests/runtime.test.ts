import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import reasoningQueue from "../index.ts";

const piDir = process.env.PI_TEST_CODING_AGENT;

test("pi prepares queued reasoning and per-level sampling natively", { skip: !piDir, timeout: 15_000 }, async () => {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(piDir!, "dist/index.js")).href);
	const { InMemoryCredentialStore, InMemoryModelsStore } = await import(pathToFileURL(join(piDir!, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "pi-reasoning-test-"));
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let session;
	try {
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerProvider("queue-test", {
			api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "test",
			models: [{
				id: "queue-test", name: "Queue Test", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
				samplingParamsByThinkingLevel: { low: { temperature: 0.3 }, medium: { temperature: 0.6 }, high: { temperature: 0.9 } },
			}],
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, followUpMode: "one-at-a-time", steeringMode: "one-at-a-time" });
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [reasoningQueue] });
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: modelRuntime.getModel("queue-test", "queue-test"), thinkingLevel: "medium", resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), noTools: true }));
		const extensionErrors: unknown[] = [];
		await session.bindExtensions({ onError: (error: unknown) => extensionErrors.push(error) });
		const payloads: Array<{ reasoning_effort: string; temperature: number; messages: unknown[] }> = [];
		session.agent.streamFunction = (model, context, options) => modelRuntime.streamSimple(model, context, {
			...options,
			fetch: async (_url, init) => {
				payloads.push(JSON.parse(init.body));
				if (payloads.length === 1) {
					started.resolve();
					await gate.promise;
				}
				const chunk = { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const run = session.prompt(":medium initial");
		await started.promise;
		assert.equal(await session.steer(":low steered"), "queued");
		assert.equal(await session.followUp(":high followup"), "queued");
		assert.equal(session.thinkingLevel, "medium");
		gate.resolve();
		await run;
		await session.waitForIdle();
		assert.deepEqual(payloads.map((payload) => [payload.reasoning_effort, payload.temperature]), [["medium", 0.6], ["low", 0.3], ["high", 0.9]]);
		assert.equal(JSON.stringify(payloads).includes(":low steered"), false);
		assert.deepEqual(extensionErrors, []);
	} finally {
		gate.resolve();
		await session?.abort();
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
