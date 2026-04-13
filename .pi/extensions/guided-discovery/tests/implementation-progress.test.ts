import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	buildImplementationProgressSnapshot,
	createImplementationProgressState,
	describeLoopLanes,
	reduceImplementationProgress,
} from "../implementation-progress.ts";
import { renderImplementationProgressWidget } from "../implementation-progress-widget.ts";
import type { DecompositionPhase } from "../structured-output.ts";

function phase(id: string, title: string, touchedPaths: string[], designSensitive = false): DecompositionPhase {
	return {
		id,
		title,
		goal: title,
		instructions: [`Implement ${title}`],
		dependsOn: [],
		touchedPaths,
		parallelSafe: true,
		designSensitive,
	};
}

test("decomposer-completed plus batches-computed expands the implementation placeholder into execution batches", () => {
	const phases = [
		phase("phase-1", "Docs", ["docs"]),
		phase("phase-2", "Tests", ["tests"]),
		phase("phase-3", "More docs", ["docs/README.md"]),
	];

	let state = createImplementationProgressState({ detailLines: ["waiting"] });
	assert.equal(state.implementation.expanded, false);
	assert.equal(state.implementation.batches.length, 0);

	state = reduceImplementationProgress(state, { type: "decomposer-started" });
	assert.deepEqual(state.activeLocations, [{ nodeId: "decomposer" }]);
	assert.equal(state.nodes.decomposer.status, "active");
	assert.equal(state.nodes.decomposer.visits, 1);

	state = reduceImplementationProgress(state, {
		type: "decomposer-completed",
		phases,
		detailLines: ["Decomposition complete"],
	});
	state = reduceImplementationProgress(state, {
		type: "batches-computed",
		phases,
	});

	assert.equal(state.nodes.decomposer.status, "done");
	assert.equal(state.implementation.expanded, true);
	assert.equal(state.implementation.totalPhases, 3);
	assert.deepEqual(
		state.implementation.batches.map((batch) => batch.phases.map((item) => item.id)),
		[["phase-1", "phase-2"], ["phase-3"]],
	);
	assert.equal(state.implementation.batches[0].parallel, true);
	assert.equal(state.nodes.implementation.status, "pending");
	assert.deepEqual(state.detailLines, ["Decomposition complete"]);
});

test("targeted follow-through and final checker reruns reuse the same nodes without duplicating the workflow graph", () => {
	const phases = [
		phase("phase-1", "Docs", ["docs"]),
		phase("phase-2", "Tests", ["tests"]),
	];

	let state = reduceImplementationProgress(createImplementationProgressState(), {
		type: "decomposer-completed",
		phases,
	});
	state = reduceImplementationProgress(state, {
		type: "batches-computed",
		phases,
		batches: [phases],
	});

	state = reduceImplementationProgress(state, { type: "batch-started", batchIndex: 0 });
	state = reduceImplementationProgress(state, { type: "phase-started", phaseId: "phase-1" });
	state = reduceImplementationProgress(state, { type: "phase-started", phaseId: "phase-2" });

	assert.equal(state.nodes.implementation.status, "active");
	assert.equal(state.nodes.implementation.visits, 1);
	assert.deepEqual(
		state.activeLocations.map((location) => location.phaseId).sort(),
		["phase-1", "phase-2"],
	);

	state = reduceImplementationProgress(state, { type: "phase-completed", phaseId: "phase-1" });
	state = reduceImplementationProgress(state, { type: "phase-completed", phaseId: "phase-2" });
	state = reduceImplementationProgress(state, { type: "batch-completed", batchIndex: 0 });

	state = reduceImplementationProgress(state, { type: "cleanup-started" });
	state = reduceImplementationProgress(state, { type: "cleanup-completed" });
	state = reduceImplementationProgress(state, { type: "design-skipped" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "cleanup->fix" });
	state = reduceImplementationProgress(state, { type: "fix-started" });
	state = reduceImplementationProgress(state, { type: "fix-completed" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "fix->cleanup" });
	state = reduceImplementationProgress(state, { type: "cleanup-started" });
	state = reduceImplementationProgress(state, { type: "cleanup-completed" });
	state = reduceImplementationProgress(state, { type: "design-started" });
	state = reduceImplementationProgress(state, { type: "design-completed" });
	state = reduceImplementationProgress(state, { type: "checker-started" });
	state = reduceImplementationProgress(state, { type: "checker-completed" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "checker->fix" });
	state = reduceImplementationProgress(state, { type: "fix-started" });
	state = reduceImplementationProgress(state, { type: "fix-completed" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "fix->checker" });
	state = reduceImplementationProgress(state, { type: "checker-started" });

	assert.equal(state.nodes.implementation.status, "done");
	assert.equal(state.nodes.cleanup.status, "done");
	assert.equal(state.nodes.cleanup.visits, 2);
	assert.equal(state.nodes.design.status, "done");
	assert.equal(state.nodes.design.visits, 1);
	assert.equal(state.nodes.checker.status, "active");
	assert.equal(state.nodes.checker.visits, 2);
	assert.equal(state.nodes.fix.visits, 2);
	assert.deepEqual(state.activeLocations, [{ nodeId: "checker" }]);
	assert.equal(state.edgeTraversalCounts["cleanup->fix"], 1);
	assert.equal(state.edgeTraversalCounts["fix->cleanup"], 1);
	assert.equal(state.edgeTraversalCounts["checker->fix"], 1);
	assert.equal(state.edgeTraversalCounts["fix->checker"], 1);
});

test("design-skipped marks the design node explicitly instead of leaving it pending", () => {
	let state = createImplementationProgressState();
	state = reduceImplementationProgress(state, { type: "cleanup-started" });
	state = reduceImplementationProgress(state, { type: "cleanup-completed" });
	state = reduceImplementationProgress(state, { type: "design-skipped" });

	assert.equal(state.nodes.design.status, "skipped");
	assert.equal(state.nodes.design.visits, 0);
	assert.deepEqual(state.activeLocations, []);

	state = reduceImplementationProgress(state, { type: "design-started" });
	assert.equal(state.nodes.design.status, "active");
	assert.equal(state.nodes.design.visits, 1);
});

test("describeLoopLanes caps visible lanes at three and preserves total traversal counts", () => {
	assert.deepEqual(describeLoopLanes(0), {
		totalTraversals: 0,
		visibleLanes: 0,
		overflowCount: 0,
		badge: null,
	});
	assert.deepEqual(describeLoopLanes(2), {
		totalTraversals: 2,
		visibleLanes: 2,
		overflowCount: 0,
		badge: "×2",
	});
	assert.deepEqual(describeLoopLanes(5), {
		totalTraversals: 5,
		visibleLanes: 3,
		overflowCount: 2,
		badge: "×5",
	});
});

test("widget loop summary ignores baseline pipeline traversals", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as const;

	let state = createImplementationProgressState();
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "decomposer->implementation" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "implementation->cleanup" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "cleanup->design" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "design->checker" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "checker->fix" });

	const rendered = renderImplementationProgressWidget(theme as Theme, state, 140).join("\n");

	assert.match(rendered, /retries 1/);
	assert.match(rendered, /C→F/);
	assert.doesNotMatch(rendered, /D→I/);
	assert.doesNotMatch(rendered, /I→Cl/);
	assert.doesNotMatch(rendered, /Cl→Des/);
	assert.doesNotMatch(rendered, /Des→C/);
	assert.doesNotMatch(rendered, /retries 0/);
	assert.doesNotMatch(rendered, /revisited 0/);
});

test("snapshot layout keeps the active batch expanded and abbreviates labels in compact mode", () => {
	const phases = [
		phase("phase-1", "Introduce implementation progress graph state", ["src/shared"]),
		phase("phase-2", "Track cleanup and design traversal counts", ["src/shared"], true),
		phase("phase-3", "Keep compact labels readable on narrow terminals", ["src/shared"]),
		phase("phase-4", "Summarize inactive batches without losing context", ["src/shared"]),
	];

	let state = reduceImplementationProgress(createImplementationProgressState(), {
		type: "decomposer-completed",
		phases,
	});
	state = reduceImplementationProgress(state, {
		type: "batches-computed",
		phases,
	});
	state = reduceImplementationProgress(state, { type: "batch-started", batchIndex: 1 });
	state = reduceImplementationProgress(state, { type: "phase-started", phaseId: "phase-2" });
	state = reduceImplementationProgress(state, { type: "loop-traversed", edge: "checker->fix", count: 4 });

	const snapshot = buildImplementationProgressSnapshot(state, { width: 68 });
	const collapsedBatch = snapshot.implementation.batches.find((batch) => batch.index === 0);
	const expandedBatch = snapshot.implementation.batches.find((batch) => batch.index === 1);
	const checkerFixLoop = snapshot.loops.find((loop) => loop.edge === "checker->fix");

	assert.equal(snapshot.layout.compact, true);
	assert.equal(snapshot.layout.abbreviateLabels, true);
	assert.deepEqual(snapshot.layout.expandedBatchIndices, [1]);
	assert.equal(collapsedBatch?.display, "collapsed");
	assert.equal(expandedBatch?.display, "expanded");
	assert.equal(expandedBatch?.phases.length, 1);
	assert.equal(snapshot.pipeline.find((node) => node.id === "decomposer")?.label, "Decomp");
	assert.equal(snapshot.pipeline.find((node) => node.id === "implementation")?.label, "Implement");
	assert.equal(snapshot.pipeline.find((node) => node.id === "cleanup")?.label, "Clean");
	assert.equal(snapshot.pipeline.find((node) => node.id === "design")?.label, "Design");
	assert.equal(checkerFixLoop?.visibleLanes, 3);
	assert.equal(checkerFixLoop?.badge, "×4");
	assert.equal(expandedBatch?.phases[0]?.label.endsWith("…"), true);
});

test("snapshot hides unused fix nodes until the workflow actually touches them", () => {
	const phases = [phase("phase-1", "Implement billing flow", ["src/billing"], true)];

	let state = reduceImplementationProgress(createImplementationProgressState(), {
		type: "decomposer-completed",
		phases,
	});
	state = reduceImplementationProgress(state, {
		type: "batches-computed",
		phases,
		batches: [phases],
	});
	state = reduceImplementationProgress(state, { type: "batch-started", batchIndex: 0 });
	state = reduceImplementationProgress(state, { type: "phase-started", phaseId: "phase-1" });

	const snapshot = buildImplementationProgressSnapshot(state, { width: 120 });
	const pipelineIds = snapshot.pipeline.map((node) => node.id);

	assert.deepEqual(pipelineIds, ["decomposer", "implementation", "cleanup", "design", "checker", "validator"]);
	assert.equal(snapshot.pipeline.find((node) => node.id === "checker")?.fullLabel, "Code review");
	assert.equal(snapshot.pipeline.find((node) => node.id === "validator")?.fullLabel, "Plan check");
});

test("widget renders usage summary lines between telemetry and detail lines", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as const;

	let state = createImplementationProgressState({ detailLines: ["Queued worker batches"] });
	state = reduceImplementationProgress(state, { type: "decomposer-started" });

	const rendered = renderImplementationProgressWidget(theme as Theme, state, 110, {
		usageSummaryLines: [
			"Cost ▸ total $0.123 • session $0.078 • subagents $0.045",
			"Tokens ▸ ↑12k • ↓4.5k",
		],
	}).join("\n");

	assert.match(rendered, /Cost ▸ total \$0\.123 • session \$0\.078 • subagents \$0\.045/);
	assert.match(rendered, /Tokens ▸ ↑12k • ↓4\.5k/);
	assert.ok(rendered.indexOf("Cost ▸") < rendered.indexOf("· Queued worker batches"));
});
