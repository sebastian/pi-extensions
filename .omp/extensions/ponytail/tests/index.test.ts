import assert from "node:assert/strict";
import test from "node:test";
import ponytailExtension, {
	parsePonytailCommand,
	resolveSessionMode,
} from "../index.ts";

interface TestContext {
	hasUI: boolean;
	isIdle: () => boolean;
	sessionManager: { getBranch: () => unknown[] };
	ui: {
		notify: (message: string, level: string) => void;
		setStatus: (key: string, text: string) => void;
		theme: { fg: (color: string, text: string) => string };
	};
	notices: Array<{ message: string; level: string }>;
	statuses: Array<{ key: string; text: string }>;
}

type Handler = (
	event: unknown,
	context: TestContext,
) => Promise<unknown> | unknown;

type Command = {
	handler: (args: string, context: TestContext) => Promise<void> | void;
};

function createHarness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const messages: Array<{ text: string; options?: { deliverAs?: string } }> =
		[];
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendUserMessage(text: string, options?: { deliverAs?: string }) {
			messages.push({ text, options });
		},
	};
	ponytailExtension(api as never);
	return { commands, entries, handlers, messages };
}

function createContext(branch: unknown[] = [], idle = true) {
	const notices: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; text: string }> = [];
	return {
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, level: string) =>
				notices.push({ message, level }),
			setStatus: (key: string, text: string) => statuses.push({ key, text }),
			theme: { fg: (_color: string, text: string) => text },
		},
		notices,
		statuses,
	};
}

test("command parser accepts runtime modes and rejects review as a default", () => {
	assert.deepEqual(parsePonytailCommand(" ultra "), {
		type: "set-mode",
		mode: "ultra",
	});
	assert.deepEqual(parsePonytailCommand("default lite"), {
		type: "set-default",
		mode: "lite",
	});
	assert.deepEqual(parsePonytailCommand("default review"), {
		type: "invalid",
		reason: "invalid-default-mode",
	});
	assert.deepEqual(parsePonytailCommand("", "off"), {
		type: "set-mode",
		mode: "full",
	});
});

test("latest valid session entry wins", () => {
	assert.equal(
		resolveSessionMode(
			[
				{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
				{ type: "custom", customType: "other", data: { mode: "ultra" } },
				{
					type: "custom",
					customType: "ponytail-mode",
					data: { mode: "ultra" },
				},
			],
			"full",
		),
		"ultra",
	);
});

test("OMP extension registers commands, persists mode, and injects filtered instructions", async () => {
	const { commands, entries, handlers } = createHarness();
	const context = createContext();

	assert.deepEqual([...commands.keys()].sort(), [
		"ponytail",
		"ponytail-audit",
		"ponytail-debt",
		"ponytail-gain",
		"ponytail-help",
		"ponytail-review",
	]);
	await handlers.get("session_start")?.({}, context);
	await commands.get("ponytail")?.handler("ultra", context);
	assert.deepEqual(entries.at(-1), {
		customType: "ponytail-mode",
		data: { mode: "ultra" },
	});

	const result = (await handlers.get("before_agent_start")?.(
		{ systemPrompt: "BASE" },
		context,
	)) as { systemPrompt: string };
	assert.ok(
		result.systemPrompt.startsWith(
			"BASE\n\nPONYTAIL MODE ACTIVE — level: ultra",
		),
	);
	assert.match(result.systemPrompt, /ultra: "No cache until/);
	assert.doesNotMatch(result.systemPrompt, /lite: "Done, cache added/);
});

test("session restore and exact deactivation use OMP's branch API", async () => {
	const { handlers } = createHarness();
	const context = createContext([
		{ type: "custom", customType: "ponytail-mode", data: { mode: "lite" } },
	]);
	await handlers.get("session_start")?.({}, context);
	const active = (await handlers.get("before_agent_start")?.(
		{ systemPrompt: "BASE" },
		context,
	)) as { systemPrompt: string };
	assert.match(active.systemPrompt, /level: lite/);

	await handlers.get("input")?.(
		{ text: "add a normal mode toggle", source: "interactive" },
		context,
	);
	assert.ok(
		await handlers.get("before_agent_start")?.(
			{ systemPrompt: "BASE" },
			context,
		),
	);
	await handlers.get("input")?.(
		{ text: "normal mode.", source: "interactive" },
		context,
	);
	assert.equal(
		await handlers.get("before_agent_start")?.(
			{ systemPrompt: "BASE" },
			context,
		),
		undefined,
	);
});

test("skill aliases use OMP skill commands and queue while busy", async () => {
	const { commands, messages } = createHarness();
	await commands.get("ponytail-review")?.handler("", createContext([], false));
	assert.deepEqual(messages, [
		{ text: "/skill:ponytail-review", options: { deliverAs: "followUp" } },
	]);
});
