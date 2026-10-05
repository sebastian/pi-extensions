import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { summarizeReviewTool } from "./review-progress.ts";
import type { SubagentEvent } from "./subagent-runner.ts";
import type { QueueState, TaskPhase, WorkTask } from "./work-queue.ts";

const FEEDBACK_ROWS = 6;
const FEEDBACK_CHARS = 8192;
const QUEUE_ROWS = 6;

function safeText(text: string): string {
	const plain = stripTerminalSequences(text).toWellFormed().replace(/\r\n/g, "\n")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, " ");
	// Copy the bounded slice: V8 substrings can otherwise retain the entire enormous source event.
	return Buffer.from(plain, "utf8").toString("utf8");
}
function titleText(text: string): string {
	return safeText(text.slice(0, 2048)).replace(/\n/g, " ");
}
interface FeedbackEntry {
	kind: SubagentEvent["type"];
	text: string;
	messageId?: number;
	contentIndex?: number;
}

/** Transient, plain-text tail. No child reasoning, tool results, or queue persistence. */
export class TaskFeedback {
	taskId?: number;
	phase?: TaskPhase;
	entries: FeedbackEntry[] = [];

	clear(): void {
		this.taskId = undefined;
		this.phase = undefined;
		this.entries = [];
	}
	sync(task?: WorkTask): void {
		const phase = task?.status === "running" ? "implementation" : task?.status === "validating" ? "validation" : undefined;
		if (task?.id === this.taskId && phase === this.phase) return;
		this.clear();
		if (!phase) return;
		this.taskId = task!.id;
		this.phase = phase;
		this.entries.push({ kind: "status", text: `Starting ${phase}…` });
	}
	update(event: SubagentEvent, taskId: number, phase: TaskPhase): boolean {
		if (taskId !== this.taskId || phase !== this.phase) return false;
		const kind = event.textMode ? "assistant" : event.type;
		const raw = kind === "tool" ? `Tool · ${titleText(summarizeReviewTool(event.toolName, event.args) ?? "tool")}`
			: kind === "thinking" ? "Thinking…" : event.message ?? "";
		// Slice BEFORE sanitizing/wrapping: even a single enormous event has bounded retained text.
		const text = safeText(raw.slice(-FEEDBACK_CHARS));
		if (kind !== "assistant" && (!text.trim() || this.entries.at(-1)?.text === text)) return false;
		if (kind === "assistant") {
			if (this.entries.at(-1)?.kind === "thinking") this.entries.pop();
			if (event.textMode === "snapshot" && event.contentIndex === undefined) {
				this.entries = this.entries.filter((entry) => entry.kind !== "assistant" || entry.messageId !== event.messageId);
			}
			const entry = this.entries.find((entry) => entry.kind === "assistant" && entry.messageId === event.messageId && entry.contentIndex === event.contentIndex);
			if (entry) entry.text = event.textMode === "snapshot" ? text : (entry.text + text).slice(-FEEDBACK_CHARS).toWellFormed();
			else this.entries.push({ kind, text, messageId: event.messageId, contentIndex: event.contentIndex });
		} else this.entries.push({ kind, text });
		this.entries = this.entries.slice(-FEEDBACK_ROWS);
		let excess = this.entries.reduce((sum, entry) => sum + entry.text.length, 0) - FEEDBACK_CHARS;
		while (excess > 0) {
			const first = this.entries[0];
			const removed = Math.min(excess, first.text.length);
			first.text = first.text.slice(removed).toWellFormed();
			excess -= removed;
			if (!first.text) this.entries.shift();
		}
		return true;
	}
}

/** Presentation only: never sort/mutate the actual pending queue. Reserve room for history. */
export function visibleTasks(tasks: WorkTask[], recentDoneIds: number[] = []): WorkTask[] {
	if (tasks.length <= QUEUE_ROWS) return tasks;
	const active = tasks.filter((task) => task.status === "running" || task.status === "validating");
	const blocked = tasks.filter((task) => task.status === "blocked");
	const pending = tasks.filter((task) => task.status === "pending");
	// Only history is sorted; remember actual recent completions, including retries of older IDs.
	const done = tasks.filter((task) => task.status === "done").sort((a, b) => recentDoneIds.indexOf(a.id) - recentDoneIds.indexOf(b.id));
	const urgent = [...active, ...blocked].slice(0, QUEUE_ROWS - Number(pending.length > 0) - Number(done.length > 0));
	const upcoming = pending.slice(0, Math.max(Number(pending.length > 0), QUEUE_ROWS - urgent.length - Math.min(2, done.length)));
	const historySlots = QUEUE_ROWS - urgent.length - upcoming.length;
	const selected = [...urgent, ...upcoming, ...(historySlots > 0 ? done.slice(-historySlots) : [])];
	const cancelledSlots = QUEUE_ROWS - selected.length;
	return [...selected, ...(cancelledSlots > 0 ? tasks.filter((task) => task.status === "cancelled").slice(-cancelledSlots) : [])];
}

const STATUS: Record<WorkTask["status"], { marker: string; color: ThemeColor }> = {
	pending: { marker: "○", color: "muted" },
	running: { marker: "▶", color: "accent" },
	validating: { marker: "◇", color: "accent" },
	done: { marker: "✓", color: "success" },
	blocked: { marker: "!", color: "warning" },
	cancelled: { marker: "×", color: "dim" },
};

/** Evaluate the current theme at render time; RPC uses the same overview without ANSI or feedback. */
export function renderQueueWidget(state: QueueState, feedback: TaskFeedback, width: number, theme?: Theme, recentDoneIds: number[] = []): string[] {
	if (width <= 0 || !state.enabled) return [];
	const fit = (text: string) => truncateToWidth(text, width, "…");
	const color = (token: ThemeColor, text: string) => theme ? theme.fg(token, text) : text;
	const selected = visibleTasks(state.tasks, recentDoneIds);
	const idWidth = Math.max(1, ...selected.map((task) => String(task.id).length));
	const lines = [color("accent", fit(`Supervisor · ${state.paused ? "paused (active work may finish)" : "one background worker"}`))];
	for (const task of selected) {
		const { marker, color: token } = STATUS[task.status];
		const prefix = `${marker} ${task.status.padEnd(10)} #${String(task.id).padStart(idWidth)} `;
		const title = truncateToWidth(titleText(task.title), Math.max(0, width - visibleWidth(prefix)), "…");
		const styledTitle = theme ? theme.style(title, { fg: task.status === "done" ? "muted" : "text", strikethrough: task.status === "done" }) : title;
		lines.push(fit(color(token, prefix) + styledTitle));
	}
	if (!selected.length) lines.push(color("muted", fit("No tasks · add work through the supervisor")));
	if (selected.length < state.tasks.length) {
		const hiddenBlocked = state.tasks.filter((task) => task.status === "blocked" && !selected.includes(task)).length;
		lines.push(color("muted", fit(`… ${state.tasks.length - selected.length} more · /tasks${hiddenBlocked ? ` (${hiddenBlocked} blocked)` : ""}`)));
	}
	lines.push(color("dim", fit("/tasks [id] · /orchestrate pause|start|cancel <id>")));
	const task = theme && state.tasks.find((task) => task.id === feedback.taskId && (task.status === "running" || task.status === "validating"));
	if (task) {
		const phase = width < 24 ? (feedback.phase === "implementation" ? "impl" : "val") : feedback.phase;
		const separator = width < 24 ? "·" : " · ";
		lines.push(theme.style(fit(`#${task.id} ${phase}${separator}${titleText(task.title)}`), { fg: "accent", bold: true }));
		const rows = feedback.entries.flatMap((entry) => {
			const text = entry.kind === "status" ? `Status · ${entry.text}` : entry.text;
			const wrapped = entry.kind === "tool" ? [fit(text)] : wrapTextWithAnsi(text, width);
			return wrapped.map((line) => color(entry.kind === "tool" ? "toolTitle" : entry.kind === "thinking" ? "muted" : "toolOutput", fit(line)));
		});
		lines.push(...rows.slice(-FEEDBACK_ROWS));
	}
	return lines;
}
