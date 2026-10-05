import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { emptyQueue, TASK_STATUSES, type QueueState, type WorkTask } from "../work-queue.ts";

// Host-provided peers, without installing anything into the repository.
const piDir = process.env.PI_TEST_CODING_AGENT;
if (piDir) {
	registerHooks({ resolve(specifier, context, next) {
		const hostPeer = specifier.startsWith("@earendil-works/pi-") || specifier === "typebox";
		return next(specifier, hostPeer ? { ...context, parentURL: pathToFileURL(join(piDir, "dist/index.js")).href } : context);
	} });
}
const ui = piDir ? await import("../orchestration-ui.ts") : undefined;
const native = piDir ? await import("@earendil-works/pi-tui") : undefined;
const themes = piDir ? await import(pathToFileURL(join(piDir, "dist/modes/interactive/theme/theme.js")).href) : undefined;
const dark: Theme = themes?.getThemeByName("dark");
const offline = { skip: !piDir };
function task(id: number, status: WorkTask["status"] = "pending", title = `Task ${id}`): WorkTask {
	return { id, status, title, request: "Self-contained work", acceptance: ["Check passes"], cost: 0 };
}
function plain(lines: string[]): string[] { return lines.map(native!.stripTerminalSequences); }
function panel(lines: string[]): string[] {
	const start = plain(lines).findIndex((line) => /^#\d+ (implementation|impl|validation|val) ?·/.test(line));
	return start < 0 ? [] : plain(lines.slice(start));
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for mocked work");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("feedback tails six rows, fits Unicode widths, and bounds huge lines/events without unsafe controls", offline, () => {
	const feedback = new ui!.TaskFeedback();
	const active = task(7, "running", "修正 👩‍💻 é parser " + "界".repeat(200));
	const state = { ...emptyQueue(), enabled: true, tasks: [active] };
	feedback.sync(active);
	feedback.update({ type: "assistant", textMode: "delta", messageId: 1, contentIndex: 0, message: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") }, 7, "implementation");
	for (const width of [1, 2, 12, 24, 40, 80]) {
		const lines = ui!.renderQueueWidget(state, feedback, width, dark);
		assert.ok(lines.every((line) => native!.visibleWidth(line) <= width), `fits ${width} columns`);
		assert.ok(lines.every((line) => !/[\r\n]/.test(line)), "one terminal line per row");
		if (width === 12) {
			assert.match(panel(lines)[0], /#7 impl·修/);
			assert.equal(panel(lines).length, 7, "narrow terminals also get only six feedback rows");
		}
		if (width >= 24) {
			assert.equal(panel(lines).length, 7, "one heading plus six feedback rows");
			assert.match(panel(lines)[0], /#7 implementation · 修/);
			if (width >= 40) assert.match(panel(lines)[0], /修正/);
			assert.match(panel(lines).at(-1)!, /row 29/);
			assert.ok(!panel(lines).join("\n").includes("row 20"));
		}
	}
	const hostile = "x".repeat(2_000_000) + "\x1b[2J\x1b]52;c;clipboard\x07\x1b_Gimage\x1b\\\x9b2J\r\b\t\u202e END";
	for (const type of ["assistant", "status", "tool"] as const) {
		feedback.update({ type, message: hostile, toolName: "read", args: { path: hostile + "\nunsafe extra row" } }, 7, "implementation");
		assert.ok(feedback.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 8192);
		assert.ok(feedback.entries.length <= 6);
		assert.ok(feedback.entries.every((entry) => !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/.test(entry.text)));
		const lines = ui!.renderQueueWidget(state, feedback, 24, dark);
		assert.ok(panel(lines).length <= 7);
		assert.ok(lines.every((line) => native!.visibleWidth(line) <= 24 && !/[\r\n]/.test(line)));
		assert.ok(!lines.join("").includes("\x1b[2J") && !lines.join("").includes("\x1b]52"));
	}
	feedback.clear();
	feedback.sync(active);
	feedback.update({ type: "assistant", textMode: "delta", messageId: 1, contentIndex: 0, message: "x".repeat(2_000_000) + "LAST" }, 7, "implementation");
	assert.match(panel(ui!.renderQueueWidget(state, feedback, 24, dark)).at(-1)!, /LAST/);
	assert.deepEqual(ui!.renderQueueWidget(state, feedback, 0, dark), []);
	active.status = "validating";
	feedback.sync(active);
	assert.match(panel(ui!.renderQueueWidget(state, feedback, 12, dark))[0], /#7 val·修/);
});

test("deltas, partial/block/final snapshots and agent-end snapshots replace instead of duplicating", offline, () => {
	const feedback = new ui!.TaskFeedback();
	feedback.sync(task(1, "running"));
	const send = (message: string, textMode: "delta" | "snapshot", contentIndex?: number, messageId = 1, type = "assistant" as "assistant" | "status") =>
		feedback.update({ type, message, textMode, messageId, contentIndex }, 1, "implementation");
	send("Hello ", "delta", 0);
	send("Hello ", "snapshot", 0); // cumulative partial keeps its trailing space
	send("world", "delta", 0);
	send("Hello world", "snapshot", 0); // text_end
	send("Second block", "snapshot", 2);
	send("Hello world\nSecond block", "snapshot"); // message_end
	send("Hello world\nSecond block", "snapshot", undefined, 1, "status"); // agent_end
	assert.deepEqual(feedback.entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text), ["Hello world\nSecond block"]);
	send("Hello world", "delta", 0, 2); // a new turn really may repeat identical text
	assert.equal(feedback.entries.filter((entry) => entry.kind === "assistant").length, 2);
	feedback.update({ type: "thinking", message: "secret hidden reasoning" }, 1, "implementation");
	assert.ok(!JSON.stringify(feedback).includes("secret"));
	feedback.update({ type: "status", message: "Checking acceptance" }, 1, "implementation");
	assert.ok(feedback.entries.some((entry) => entry.text === "Checking acceptance"));
	assert.equal(feedback.update({ type: "assistant", message: "late task" }, 2, "implementation"), false);
	feedback.sync(task(1, "validating"));
	assert.equal(feedback.phase, "validation");
	assert.ok(!JSON.stringify(feedback).includes("Hello"));
	assert.equal(feedback.update({ type: "assistant", message: "late phase" }, 1, "implementation"), false);
	feedback.sync(task(1, "done"));
	assert.equal(feedback.taskId, undefined);
	assert.deepEqual(feedback.entries, []);
});

test("persistent queue uses actual title-only strikethrough, aligned textual statuses and current themes", offline, () => {
	const feedback = new ui!.TaskFeedback();
	const state = { ...emptyQueue(), enabled: true, tasks: TASK_STATUSES.map((status, i) => task(i + 1, status, `Title ${status} 界 👩‍💻 é`)) };
	const before = structuredClone(state);
	const lines = ui!.renderQueueWidget(state, feedback, 80, dark);
	for (const status of TASK_STATUSES) assert.ok(plain(lines).some((line) => line.includes(status)));
	const rows = plain(lines).slice(1, 7);
	assert.equal(new Set(rows.map((row) => row.indexOf("#"))).size, 1);
	assert.equal(new Set(rows.map((row) => row.indexOf("Title"))).size, 1);
	const done = lines.find((line) => native!.stripTerminalSequences(line).includes("Title done"))!;
	assert.match(done, /\x1b\[[0-9;]*9[;m]/, "real SGR strikethrough, not markdown tildes");
	assert.ok(done.indexOf("done") < done.indexOf("\x1b[9m"), "only the title is struck");
	assert.ok(!lines.find((line) => native!.stripTerminalSequences(line).includes("Title cancelled"))!.includes("\x1b[9m"));
	assert.notDeepEqual(ui!.renderQueueWidget(state, feedback, 80, themes.getThemeByName("light")), lines);
	assert.deepEqual(state, before, "rendering cannot style/mutate persisted or model-facing data");
	assert.ok(!JSON.stringify(state).includes("\\u001b"));
	assert.ok(ui!.renderQueueWidget(state, feedback, 80).every((line) => !line.includes("\x1b")), "plain RPC rows");
	for (const width of [12, 24, 40]) assert.ok(ui!.renderQueueWidget(state, feedback, width, dark).every((line) => native!.visibleWidth(line) <= width));
});

test("oversized queue reserves active/blocked, ordered upcoming and recent completed rows with overflow", offline, () => {
	const tasks = [task(1, "done"), task(2, "done"), task(3, "done"), ...[8, 5, 7, 6, 4].map((id) => task(id)), task(9, "blocked"), task(10, "validating")];
	const before = structuredClone(tasks);
	assert.deepEqual(ui!.visibleTasks(tasks).map((task) => task.id), [10, 9, 8, 5, 2, 3]);
	const state = { ...emptyQueue(), enabled: true, tasks };
	const lines = plain(ui!.renderQueueWidget(state, new ui!.TaskFeedback(), 40, dark));
	assert.equal(lines.length, 9, "heading, six tasks, overflow and controls");
	assert.ok(lines.some((line) => line.includes("4 more · /tasks")));
	assert.deepEqual(tasks, before);
	assert.deepEqual(ui!.visibleTasks(tasks, [3, 1]).map((task) => task.id), [10, 9, 8, 5, 3, 1], "a recently retried older task remains visible when it completes");
	const crowded = [...Array.from({ length: 9 }, (_, i) => task(i + 1, "blocked")), task(10, "running"), task(11), task(12, "done")];
	assert.deepEqual(ui!.visibleTasks(crowded).map((task) => task.id), [10, 1, 2, 3, 11, 12]);
	assert.ok(plain(ui!.renderQueueWidget({ ...state, tasks: crowded }, new ui!.TaskFeedback(), 80, dark)).some((line) => line.includes("(6 blocked)")));
	assert.equal(ui!.visibleTasks(Array.from({ length: 20 }, (_, i) => task(i + 1, "cancelled"))).length, 6);
});

function harness(mode: ExtensionContext["mode"] = "tui", saved?: QueueState) {
	const events = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const tools = new Map<string, { execute: Function }>();
	let branch: any[] = saved ? [{ type: "custom", customType: "toolbox-work-queue-v1", data: structuredClone(saved) }] : [];
	const messages: any[] = [];
	const errors: string[] = [];
	let component: any;
	let lines: string[] = [];
	let mounts = 0;
	let renderCount = 0;
	const widgets: any[] = [];
	const pi = {
		on: (name: string, handler: Function) => events.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: unknown) => messages.push(message),
		getActiveTools: () => ["read", "write"], setActiveTools() {},
		getAllTools: () => ["read", "write", "work_queue"].map((name) => ({ name })), getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const ctx = {
		mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/unused", model: { provider: "fake", id: "fake" },
		isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: dark, notify: (message: string) => errors.push(message), setStatus() {},
			setWidget: (_key: string, content: any, options: any) => {
				assert.notEqual(mode, "json", "no UI calls in non-UI mode");
				widgets.push(content);
				component?.dispose?.();
				component = undefined;
				if (typeof content === "function") {
					assert.equal(mode, "tui", "RPC must not receive factories");
					assert.equal(options.placement, "aboveEditor");
					mounts++;
					component = content({ requestRender: () => { renderCount++; lines = component?.render(60) ?? []; } }, dark);
				}
				lines = component ? component.render(60) : content ?? [];
			},
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, events, tools, errors, messages, widgets,
		get lines() { return lines; }, get mounts() { return mounts; }, get renderCount() { return renderCount; },
		get state(): QueueState { return branch.at(-1).data; }, get saves() { return branch.length; },
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
		newBranch: () => { branch = []; },
	};
}

test("mocked child progress stays live/non-modal and resets on phases, pause/finish, cancellation, off, restoration/switch and shutdown", { ...offline, timeout: 25_000 }, async () => {
	const { default: register } = await import("../orchestration.ts");
	const dir = await mkdtemp(join(tmpdir(), "pi-orchestration-ui-"));
	const argv1 = process.argv[1];
	const h = harness();
	try {
		const fakePi = join(dir, "fake-pi.mjs");
		await writeFile(fakePi, `
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const name = process.argv[process.argv.indexOf("--name") + 1];
const id = Number(name.match(/task (\\d+)/)[1]);
const phase = name.startsWith("validate") ? "validation" : "implementation";
const emit = (event) => console.log(JSON.stringify(event));
const message = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const progress = phase + "-progress-" + id + " 界";
emit({ type: "message_start", message: message("") });
emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "NEVER SHOW HIDDEN REASONING" } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: progress } });
emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, partial: message(progress) } });
emit({ type: "auto_retry_start", attempt: 1, errorMessage: "Checking status live" });
emit({ type: "tool_execution_start", toolName: "read", args: { path: "src/task-" + id + ".ts" } });
while (!existsSync("release-" + phase + "-" + id)) await setTimeout(10);
const final = message(phase === "validation" ? JSON.stringify({ checks: [{ criterion: 1, passed: true, evidence: "Mock check passed" }] }) : "worker report " + id);
emit({ type: "message_end", message: final });
emit({ type: "agent_end", messages: [final] });
`, "utf8");
		process.argv[1] = fakePi;
		h.ctx.cwd = dir;
		register(h.pi);
		await h.events.get("session_start")!({}, h.ctx);
		await h.command("orchestrate");
		await h.command("orchestrate", "pause");
		for (const title of ["Parser 界", "Documentation 👩‍💻"]) await h.tools.get("work_queue")!.execute("add", { action: "add", title, request: "Implement", acceptance: ["Check passes"] }, undefined, undefined, h.ctx);
		await h.command("orchestrate", "start");
		await until(() => panel(h.lines).join("\n").includes("implementation-progress-1"));
		assert.match(panel(h.lines)[0], /#1 implementation · Parser 界/);
		assert.equal(panel(h.lines).join("\n").split("implementation-progress-1").length, 2);
		assert.ok(panel(h.lines).join("\n").includes("Tool · read src/task-1.ts"));
		assert.ok(panel(h.lines).join("\n").includes("Checking status live"));
		assert.ok(!h.lines.join("").includes("NEVER SHOW"));
		assert.equal(h.mounts, 1, "stream updates request rendering, not repeated widget installation/input capture");
		assert.ok(h.renderCount > 1);
		const saves = h.saves;
		await h.command("tasks");
		const modelContext = await h.events.get("context")!({ messages: [] }, h.ctx);
		assert.ok(!JSON.stringify([...h.messages, modelContext]).includes("implementation-progress"));
		assert.ok(!JSON.stringify([...h.messages, modelContext]).includes("\\u001b"));
		assert.equal(h.saves, saves, "stream/UI and reports do not persist feedback");
		await h.command("orchestrate", "pause");
		assert.match(plain(h.lines)[0], /paused/);
		await writeFile(join(dir, "release-implementation-1"), "");
		await until(() => panel(h.lines).join("\n").includes("validation-progress-1"));
		assert.match(panel(h.lines)[0], /#1 validation · Parser 界/);
		assert.ok(!h.lines.join("").includes("implementation-progress"));
		await writeFile(join(dir, "release-validation-1"), "");
		await until(() => h.state.tasks[0].status === "done");
		assert.deepEqual(panel(h.lines), []);
		assert.equal(h.state.tasks[1].status, "pending", "pause lets active work finish without dispatching the next task");
		assert.ok(h.lines.some((line) => line.includes("\x1b[9m") && line.includes("Parser")), "done stays in the widget");
		await h.command("orchestrate", "off");
		assert.deepEqual(h.lines, []);
		await h.events.get("session_tree")!({}, h.ctx);
		assert.deepEqual(panel(h.lines), []);
		await h.command("orchestrate");
		await h.command("orchestrate", "start");
		await until(() => panel(h.lines).join("\n").includes("implementation-progress-2"));
		assert.match(panel(h.lines)[0], /#2 implementation · Documentation/);
		assert.ok(!h.lines.join("").includes("progress-1"));
		const beforeCancel = h.saves;
		await h.command("orchestrate", "cancel 2");
		assert.deepEqual(panel(h.lines), [], "clears on cancel, before child exit");
		await until(() => h.saves >= beforeCancel + 2);
		await h.command("orchestrate", "retry 2");
		await h.command("orchestrate", "start");
		await until(() => panel(h.lines).join("\n").includes("implementation-progress-2"));
		const stopped = h.events.get("session_shutdown")!({}, h.ctx);
		assert.deepEqual(h.lines, [], "shutdown clears synchronously before waiting");
		await stopped;
		await h.events.get("session_start")!({}, h.ctx);
		assert.equal(h.state.tasks[1].status, "blocked");
		assert.deepEqual(panel(h.lines), [], "reload/restoration never restores live output");
		h.newBranch();
		await h.events.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.lines, [], "session switch clears the old label/output");
		assert.deepEqual(h.errors, []);
	} finally {
		await h.events.get("session_shutdown")?.({}, h.ctx);
		process.argv[1] = argv1;
		await rm(dir, { recursive: true, force: true });
	}
});

test("RPC retains a plain bounded overview; non-UI restoration/shutdown never calls terminal APIs", offline, async () => {
	const { default: register } = await import("../orchestration.ts");
	const saved = { ...emptyQueue(), enabled: true, nextId: 3, tasks: [task(1, "running"), task(2, "pending")] };
	for (const mode of ["rpc", "json"] as const) {
		const h = harness(mode, saved);
		register(h.pi);
		await h.events.get("session_start")!({}, h.ctx);
		if (mode === "rpc") {
			assert.ok(h.lines.some((line) => line.includes("blocked")));
			assert.ok(h.widgets.every((value) => value === undefined || Array.isArray(value)));
			assert.ok(h.lines.every((line) => !line.includes("\x1b")));
			await h.command("tasks", "1");
			assert.match(h.messages.at(-1).content, /Interrupted worker/);
		} else assert.equal(h.widgets.length, 0);
		await h.events.get("session_shutdown")!({}, h.ctx);
		assert.deepEqual(h.errors, []);
	}
});
