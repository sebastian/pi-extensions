import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { emptyQueue, restoreQueue, WorkQueue, type QueueAction, type WorkTask } from "./work-queue.ts";

const STATE = "toolbox-work-queue-v1";
const TOOL = "work_queue";
const SUPERVISOR_TOOLS = new Set([TOOL, "read", "grep", "find", "ls"]);
const SUPERVISOR_PROMPT = `You are the conversational supervisor of a persistent work queue, not its implementation worker.
Use work_queue to turn requested work into discrete, self-contained tasks with concrete acceptance criteria. Include all relevant user decisions, constraints and file paths in each task request: workers do not receive this conversation.
Use tools to actually add, update, cancel or reorder tasks; a prose promise does not change the queue. New messages can change the pending plan without disturbing running work. Reorder takes ALL pending IDs in the desired order. Never silently cancel a running task to satisfy a backlog change.
The extension dispatches one background worker at a time and independently validates every criterion before marking a task done. Do not poll or wait for workers: acknowledge the plan and finish your response so the user can keep talking. You may inspect files but must delegate implementation and shell commands.
On blocked work, explain the evidence and ask for a decision. Do not silently retry, weaken acceptance criteria or cancel a failed task to bypass validation. After an authorized retry, start the paused queue. Questions and discussion need not become tasks.
The live work-queue snapshot is authoritative, not older messages. Use list with an id to inspect the complete report, acceptance checks and errors. Never claim completion without a done status.`;

function summary(queue: WorkQueue): string {
	const state = queue.state;
	return `${state.enabled ? "Supervisor" : "Orchestration off"} · ${state.paused ? "paused" : "auto-dispatch"}\n${state.tasks.map((task) => `#${task.id} [${task.status}] ${task.title}${task.error ? ` — ${task.error}` : ""}`).join("\n") || "No tasks"}\nWorker + validation cost: $${state.tasks.reduce((sum, task) => sum + task.cost, 0).toFixed(4)}`;
}

export default function registerOrchestration(pi: ExtensionAPI): void {
	// Children retain safety/provider extensions, but cannot recursively supervise.
	if (process.env.PI_ORCHESTRATION_CHILD === "1") {
		// The IPC channel closes even on a parent crash. Pi's SIGTERM handler
		// aborts the run and cleans up its shell children before exiting.
		const parentGone = () => process.kill(process.pid, "SIGTERM");
		pi.on("session_start", () => {
			process.once("disconnect", parentGone);
			if (!process.connected) parentGone();
		});
		pi.on("session_shutdown", () => { process.removeListener("disconnect", parentGone); });
		return;
	}
	let ctx: ExtensionContext;
	let queue: WorkQueue;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let loadError: string | undefined;
	let persisted = false;
	let activity = "";

	function reportError(error: unknown): void {
		ctx.ui.notify(`Orchestration: ${String(error)}`, "error");
	}
	function render(): void {
		if (!ctx.hasUI) return;
		if (!queue.state.enabled) {
			ctx.ui.setWidget(STATE, undefined);
			ctx.ui.setStatus(STATE, undefined);
			return;
		}
		const tasks = queue.state.tasks;
		const unfinished = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
		ctx.ui.setStatus(STATE, `tasks ${tasks.filter((task) => task.status === "done").length}/${tasks.length}${queue.state.paused ? " paused" : ""}`);
		ctx.ui.setWidget(STATE, [
			`Supervisor · ${queue.state.paused ? "paused (active work may finish)" : "one background worker"}`,
			...unfinished.slice(0, 6).map((task) => `#${task.id} [${task.status}] ${task.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`),
			...(unfinished.length > 6 ? [`… ${unfinished.length - 6} more; /tasks shows all`] : []),
			...(queue.active && activity ? [activity] : []),
			"/tasks [id] · /orchestrate pause|start|cancel <id>",
		]);
	}
	function schedule(): void {
		if (timer || queue.closed || loadError || !queue.state.enabled || queue.state.paused || queue.active || !queue.state.tasks.some((task) => task.status === "pending")) return;
		// agent_settled is notification-only: dispatch outside that event, and never
		// race a supervisor turn which might still be reshuffling the backlog.
		timer = setTimeout(() => {
			timer = undefined;
			if (queue.closed || !queue.state.enabled || queue.state.paused || queue.active) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			try {
				if (!ctx.model) throw new Error("Select a model before dispatching work");
				activity = "Starting worker";
				const work = queue.kick({
					cwd: ctx.cwd, model: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: pi.getThinkingLevel(),
					approveProject: ctx.isProjectTrusted(), extensions: [fileURLToPath(import.meta.url)],
					onEvent: (event) => {
						if (event.type === "tool") {
							activity = `Worker: ${event.toolName}`;
							render();
						}
					},
				});
				void work?.catch((error) => { queue.state.paused = true; reportError(error); });
			} catch (error) {
				queue.state.paused = true;
				reportError(error);
			}
		}, 0);
	}
	function save(): void {
		try {
			// ponytail: snapshots suit short queues; use task deltas if session histories get large.
			pi.appendEntry(STATE, structuredClone(queue.state));
			persisted = true;
		} catch (error) {
			queue.state.paused = true;
			queue.active?.controller.abort();
			throw error;
		}
		render();
		schedule();
	}
	function completed(task: WorkTask): void {
		pi.sendMessage({
			customType: "work-queue-result", display: true,
			content: `Task #${task.id} [${task.status}]: ${task.title}\n${task.error ?? "All acceptance criteria passed."}\nUse /tasks ${task.id} for the report and validation evidence.`,
		}, { triggerTurn: false });
	}
	function setTools(): void {
		if (queue.state.enabled) pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => SUPERVISOR_TOOLS.has(name)));
	}
	function restore(context: ExtensionContext): void {
		ctx = context;
		if (timer) clearTimeout(timer);
		timer = undefined;
		loadError = undefined;
		activity = "";
		const saved = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE).at(-1);
		persisted = Boolean(saved);
		try {
			const state = saved?.type === "custom" ? restoreQueue(saved.data) : emptyQueue();
			queue = new WorkQueue(state, save, completed);
			if (!state.enabled && pi.getActiveTools().includes(TOOL)) pi.setActiveTools(state.previousTools);
			setTools();
			if (saved) save();
		} catch (error) {
			queue = new WorkQueue(emptyQueue(), save, completed);
			loadError = String(error);
			reportError(error);
		}
		render();
	}
	function requireQueue(): void {
		if (loadError) throw new Error(loadError);
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Orchestration needs an interactive or RPC session, not a one-shot process");
		if (!queue.state.enabled) throw new Error("Enable supervisor mode with /orchestrate on first");
	}
	function show(id?: number): void {
		if (loadError) throw new Error(loadError);
		const task = queue.state.tasks.find((item) => item.id === id);
		if (id !== undefined && !task) throw new Error(`No task #${id}`);
		pi.sendMessage({
			customType: "work-queue-status", display: true,
			content: task ? JSON.stringify(task, null, 2) : summary(queue),
		}, { triggerTurn: false });
	}

	pi.registerTool({
		name: TOOL, label: "Work queue", defaultActive: false, executionMode: "sequential",
		description: "Manage tracked background tasks. add requires title, self-contained request and acceptance criteria. update edits pending/blocked tasks. reorder takes every pending ID exactly once. cancel explicitly stops a task (no rollback). retry requeues a stopped blocked/cancelled task; start resumes dispatch. pause lets active work finish. list with id includes reports; list alone returns the plan. Returns immediately; never wait for a worker.",
		parameters: Type.Object({
			action: StringEnum(["list", "add", "update", "reorder", "cancel", "retry", "start", "pause"] as const),
			id: Type.Optional(Type.Integer({ minimum: 1 })),
			title: Type.Optional(Type.String({ minLength: 1 })),
			request: Type.Optional(Type.String({ minLength: 1 })),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			order: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true })),
		}),
		async execute(_id, params, _signal, _update, context) {
			ctx = context;
			requireQueue();
			queue.apply(params as QueueAction);
			const task = params.id === undefined ? undefined : queue.state.tasks.find((item) => item.id === params.id);
			if (params.action === "list" && params.id !== undefined && !task) throw new Error(`No task #${params.id}`);
			const content = task ? JSON.stringify(task) : summary(queue);
			return { content: [{ type: "text", text: content }], details: undefined };
		},
	});

	pi.registerCommand("orchestrate", {
		description: "Supervisor mode: on, off, start, pause, cancel <id>, retry <id>, status [id]",
		handler: async (args, context) => {
			ctx = context;
			try {
				if (loadError) throw new Error(loadError);
				const [action = "status", rawId, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (extra.length || (rawId !== undefined && !/^[1-9]\d*$/.test(rawId))) throw new Error("Expected an action and optional numeric task ID");
				const id = rawId === undefined ? undefined : Number(rawId);
				if (id !== undefined && !Number.isSafeInteger(id)) throw new Error("Invalid task ID");
				if (action === "status") { show(id); return; }
				if (action === "on" || action === "off") {
					if (id !== undefined) throw new Error("on/off take no task ID");
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the foreground response and queued messages before changing supervisor mode");
					if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Use a long-lived interactive or RPC session");
					if (action === "on" && !queue.state.enabled) {
						queue.state.previousTools = pi.getActiveTools();
						queue.state.enabled = true;
						queue.state.paused = true;
						setTools();
						// Existing work remains paused until explicitly started.
						if (queue.state.tasks.length === 0) queue.state.paused = false;
					} else if (action === "off") {
						if (queue.active) throw new Error("Pause and wait for the active task, or cancel it, before turning supervision off");
						if (queue.state.enabled) pi.setActiveTools(queue.state.previousTools);
						queue.state.enabled = false;
						queue.state.paused = true;
					}
					save();
				} else {
					requireQueue();
					if (!["pause", "start", "cancel", "retry"].includes(action)) throw new Error("Use on, off, start, pause, cancel <id>, retry <id>, or status [id]");
					if ((action === "cancel" || action === "retry") !== (id !== undefined)) throw new Error("Only cancel/retry require a task ID");
					queue.apply({ action, id } as QueueAction);
				}
				show();
			} catch (error) { reportError(error); }
		},
	});
	pi.registerCommand("tasks", {
		description: "Show the tracked work queue, or /tasks <id> for a report and acceptance checks",
		handler: async (args, context) => {
			ctx = context;
			try {
				if (args.trim() && !/^[1-9]\d*$/.test(args.trim())) throw new Error("Usage: /tasks [id]");
				show(args.trim() ? Number(args.trim()) : undefined);
			} catch (error) { reportError(error); }
		},
	});

	pi.on("session_start", (_event, context) => restore(context));
	pi.on("session_tree", (_event, context) => restore(context));
	pi.on("before_agent_start", (event, context) => {
		ctx = context;
		if (queue.state.enabled) {
			setTools();
			event.systemPromptOptions.sections.orchestration = SUPERVISOR_PROMPT;
		}
	});
	pi.on("context", (event) => {
		if (!queue.state.enabled) return;
		return { messages: [...event.messages, {
			role: "custom" as const, customType: "live-work-queue", display: false, timestamp: Date.now(),
			content: `Current work queue (use work_queue list with an id for details):\n${summary(queue)}`,
		}] };
	});
	pi.on("tool_call", (event) => {
		if (queue.state.enabled && !SUPERVISOR_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Supervisor mode: delegate implementation and shell commands through work_queue. Use /orchestrate off for direct work." };
		}
	});
	pi.on("agent_settled", (_event, context) => { ctx = context; schedule(); });
	const beforeBranch = (_event: unknown, context: ExtensionContext) => {
		if (queue.state.enabled) {
			context.ui.notify("Turn orchestration off before tree navigation or forking. This avoids replaying work against an already changed workspace.", "warning");
			return { cancel: true };
		}
	};
	pi.on("session_before_tree", beforeBranch);
	pi.on("session_before_fork", beforeBranch);
	pi.on("session_shutdown", async (_event, context) => {
		ctx = context;
		if (timer) clearTimeout(timer);
		timer = undefined;
		await queue.shutdown();
		if (persisted && !loadError) save();
		ctx.ui.setWidget(STATE, undefined);
		ctx.ui.setStatus(STATE, undefined);
	});
}
