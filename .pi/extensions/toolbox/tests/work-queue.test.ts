import test from "node:test";
import assert from "node:assert/strict";
import { emptyQueue, parseValidation, restoreQueue, WorkQueue, type WorkTask } from "../work-queue.ts";
import type { SubagentInvocation, SubagentRunResult } from "../subagent-runner.ts";

const options = { cwd: "/repo", model: "provider/model", thinkingLevel: "high" };
const passing = JSON.stringify({ checks: [{ criterion: 1, passed: true, evidence: "Ran the required check: exit 0" }] });
function result(assistantText = "Implemented the task"): SubagentRunResult {
	return { exitCode: 0, stderr: "", assistantText, messages: [], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.1, turns: 1 } };
}
function add(queue: WorkQueue, title: string): void {
	queue.apply({ action: "add", title, request: `Implement ${title}`, acceptance: ["Required check passes"] });
}
function setup() {
	const calls: Array<{ invocation: SubagentInvocation; gate: ReturnType<typeof Promise.withResolvers<SubagentRunResult>> }> = [];
	const snapshots: unknown[] = [];
	const completed: WorkTask[] = [];
	const queue = new WorkQueue(emptyQueue(), () => snapshots.push(structuredClone(queue.state)), (task) => completed.push(structuredClone(task)), async (invocation) => {
		assert.ok(snapshots.length, "persist before dispatch");
		const gate = Promise.withResolvers<SubagentRunResult>();
		calls.push({ invocation, gate });
		const output = await gate.promise;
		invocation.signal?.throwIfAborted();
		invocation.onUsage?.(output.usage);
		return output;
	});
	return { queue, calls, snapshots, completed };
}
async function tick(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }
async function finish(calls: ReturnType<typeof setup>["calls"], index: number, output = result()): Promise<void> {
	calls[index].gate.resolve(output);
	await tick();
}

test("queues are off and paused by default; adding work alone cannot start a worker", () => {
	const { queue, calls } = setup();
	add(queue, "A");
	queue.kick(options);
	assert.equal(queue.state.enabled, false);
	assert.equal(queue.state.paused, true);
	assert.equal(calls.length, 0);
});

test("foreground mutations reorder pending tasks without interrupting the single worker", async () => {
	const { queue, calls, completed } = setup();
	queue.state.enabled = true;
	for (const title of ["A", "B", "C"]) add(queue, title);
	queue.apply({ action: "start" });
	queue.kick(options);
	assert.equal(calls.length, 1, "dispatch returns without awaiting the worker");
	const done = queue.active!.done;
	queue.apply({ action: "reorder", order: [3, 2] });
	queue.apply({ action: "update", id: 2, request: "Updated instructions for B" });
	assert.equal(calls[0].invocation.signal!.aborted, false);
	assert.throws(() => queue.apply({ action: "update", id: 1, title: "changed" }), /Only pending/);
	assert.throws(() => queue.apply({ action: "reorder", order: [2, 2] }), /exactly once/);
	queue.kick(options);
	assert.equal(calls.length, 1);
	await finish(calls, 0);
	assert.equal(queue.state.tasks.find((task) => task.id === 1)!.status, "validating");
	assert.equal(calls[1].invocation.tools!.includes("write"), false);
	assert.equal(calls[0].invocation.env!.PI_ORCHESTRATION_CHILD, "1");
	await finish(calls, 1, result(passing));
	await done;
	assert.equal(completed[0].status, "done");
	assert.equal(completed[0].cost, 0.2);
	queue.kick(options);
	assert.match(calls[2].invocation.prompt, /"title":"C"/);
	const stopped = queue.shutdown();
	await finish(calls, 2);
	await stopped;
});

test("failed validation pauses the queue; retry needs an explicit restart", async () => {
	const { queue, calls } = setup();
	queue.state.enabled = true;
	add(queue, "A");
	add(queue, "B");
	queue.apply({ action: "start" });
	queue.kick(options);
	await finish(calls, 0);
	await finish(calls, 1, result(JSON.stringify({ checks: [{ criterion: 1, passed: false, evidence: "The required test failed" }] })));
	assert.equal(queue.state.tasks[0].status, "blocked");
	assert.equal(queue.state.paused, true);
	assert.equal(queue.state.tasks[0].validation!.checks[0].passed, false);
	queue.kick(options);
	assert.equal(calls.length, 2);
	assert.throws(() => queue.apply({ action: "start" }), /blocked tasks/);
	queue.apply({ action: "update", id: 1, request: "Fix the reported failure without weakening acceptance" });
	queue.apply({ action: "retry", id: 1 });
	queue.kick(options);
	assert.equal(calls.length, 2);
	queue.apply({ action: "start" });
	queue.kick(options);
	assert.match(calls[2].invocation.prompt, /required test failed/);
	const stopped = queue.shutdown();
	await finish(calls, 2);
	await stopped;
});

test("pause lets active validation finish; cancellation keeps the slot occupied until the process stops", async () => {
	const { queue, calls } = setup();
	queue.state.enabled = true;
	add(queue, "A");
	add(queue, "B");
	queue.apply({ action: "start" });
	queue.kick(options);
	queue.apply({ action: "pause" });
	assert.equal(calls[0].invocation.signal!.aborted, false);
	await finish(calls, 0);
	await finish(calls, 1, result(passing));
	assert.equal(queue.state.tasks[0].status, "done");
	queue.kick(options);
	assert.equal(calls.length, 2);
	queue.apply({ action: "start" });
	queue.kick(options);
	const done = queue.active!.done;
	queue.apply({ action: "cancel", id: 2 });
	assert.equal(calls[2].invocation.signal!.aborted, true);
	assert.throws(() => queue.apply({ action: "retry", id: 2 }), /stopped/);
	queue.kick(options);
	assert.equal(calls.length, 3);
	await finish(calls, 2);
	await done;
	assert.equal(queue.state.tasks[1].status, "cancelled");
});

test("only well-formed evidence for all criteria can pass; crashes and length limits cannot complete", async () => {
	for (const invalid of ["{}", "no JSON", '{"checks":[]}', '{"checks":[{"criterion":1,"passed":"true","evidence":"x"}]}', '{"checks":[{"criterion":1,"passed":true,"evidence":" "}]}']) {
		assert.throws(() => parseValidation(invalid, ["one"]));
	}
	assert.throws(() => parseValidation('{"checks":[{"criterion":1,"passed":true,"evidence":"x"},{"criterion":1,"passed":true,"evidence":"y"}]}', ["one", "two"]), /Duplicate/);
	for (const bad of [{ ...result(), exitCode: 1 }, { ...result(), stopReason: "length" }, { ...result(), assistantText: "" }]) {
		const queue = new WorkQueue({ ...emptyQueue(), enabled: true, paused: false }, () => {}, () => {}, async () => bad);
		add(queue, "A");
		queue.kick(options);
		await queue.active!.done;
		assert.equal(queue.state.tasks[0].status, "blocked");
		assert.equal(queue.state.paused, true);
	}
});

test("restore pauses without replay, preserves completed checks and rejects corrupted state", () => {
	const { queue } = setup();
	queue.state.enabled = true;
	for (const title of ["A", "B", "C"]) add(queue, title);
	queue.state.tasks[0].status = "running";
	queue.state.tasks[1].status = "done";
	queue.state.tasks[1].validation = parseValidation(passing, ["one"]);
	queue.state.paused = false;
	const restored = restoreQueue(queue.state);
	assert.equal(restored.enabled, true);
	assert.equal(restored.paused, true);
	assert.deepEqual(restored.tasks.map((task) => task.status), ["blocked", "done", "pending"]);
	assert.match(restored.tasks[0].error!, /Interrupted/);
	assert.throws(() => restoreQueue({}), /Invalid saved/);
	assert.throws(() => restoreQueue({ ...queue.state, tasks: [queue.state.tasks[0], queue.state.tasks[0]] }), /IDs/);
	assert.throws(() => restoreQueue({ ...queue.state, tasks: [{ ...queue.state.tasks[1], validation: undefined }] }), /lacks passing/);
});

test("persistence failures prevent dispatch and shutdown waits for active work", async () => {
	const { queue, calls, completed } = setup();
	queue.state.enabled = true;
	add(queue, "A");
	queue.apply({ action: "start" });
	const snapshots = structuredClone(queue.state);
	let spawned = false;
	const broken = new WorkQueue(snapshots, () => { throw new Error("disk full"); }, () => {}, async () => { spawned = true; return result(); });
	assert.throws(() => broken.kick(options), /disk full/);
	assert.equal(spawned, false);
	queue.kick(options);
	let closed = false;
	const stopped = queue.shutdown().then(() => { closed = true; });
	await tick();
	assert.equal(closed, false);
	assert.equal(calls[0].invocation.signal!.aborted, true);
	await finish(calls, 0);
	await stopped;
	assert.equal(queue.state.tasks[0].status, "blocked");
	assert.equal(completed.length, 0, "shutdown cannot report into a replaced session");
});
