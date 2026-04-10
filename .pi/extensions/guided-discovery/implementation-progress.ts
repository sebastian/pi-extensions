import { computeExecutionBatches } from "./changes.ts";
import type { DecompositionPhase } from "./structured-output.ts";

export const WORKFLOW_NODE_ORDER = [
	"decomposer",
	"implementation",
	"cleanup",
	"design",
	"checker",
	"fix",
	"validator",
	"finish",
] as const;
export const WORKFLOW_EDGE_ORDER = [
	"decomposer->implementation",
	"implementation->cleanup",
	"cleanup->design",
	"cleanup->checker",
	"design->checker",
	"cleanup->fix",
	"design->fix",
	"checker->fix",
	"fix->cleanup",
	"checker->validator",
	"validator->finish",
	"finish->cleanup",
] as const;

export type WorkflowNodeId = (typeof WORKFLOW_NODE_ORDER)[number];
export type WorkflowEdgeId = (typeof WORKFLOW_EDGE_ORDER)[number];
export type ProgressStatus = "pending" | "active" | "done" | "error" | "skipped";
export type BatchDisplayMode = "expanded" | "collapsed";

export const WORKFLOW_EDGE_META: Record<
	WorkflowEdgeId,
	{ from: WorkflowNodeId; to: WorkflowNodeId; label: string; shortLabel: string }
> = {
	"decomposer->implementation": {
		from: "decomposer",
		to: "implementation",
		label: "Decomposer → Implementation",
		shortLabel: "D→I",
	},
	"implementation->cleanup": {
		from: "implementation",
		to: "cleanup",
		label: "Implementation → Cleanup",
		shortLabel: "I→Cl",
	},
	"cleanup->design": {
		from: "cleanup",
		to: "design",
		label: "Cleanup → Design",
		shortLabel: "Cl→Des",
	},
	"cleanup->checker": {
		from: "cleanup",
		to: "checker",
		label: "Cleanup → Checker",
		shortLabel: "Cl→C",
	},
	"design->checker": {
		from: "design",
		to: "checker",
		label: "Design → Checker",
		shortLabel: "Des→C",
	},
	"cleanup->fix": {
		from: "cleanup",
		to: "fix",
		label: "Cleanup → Fix",
		shortLabel: "Cl→F",
	},
	"design->fix": {
		from: "design",
		to: "fix",
		label: "Design → Fix",
		shortLabel: "Des→F",
	},
	"checker->fix": {
		from: "checker",
		to: "fix",
		label: "Checker → Fix",
		shortLabel: "C→F",
	},
	"fix->cleanup": {
		from: "fix",
		to: "cleanup",
		label: "Fix → Cleanup",
		shortLabel: "F→Cl",
	},
	"checker->validator": {
		from: "checker",
		to: "validator",
		label: "Checker → Validator",
		shortLabel: "C→V",
	},
	"validator->finish": {
		from: "validator",
		to: "finish",
		label: "Validator → Finish",
		shortLabel: "V→Fin",
	},
	"finish->cleanup": {
		from: "finish",
		to: "cleanup",
		label: "Finish → Cleanup",
		shortLabel: "Fin→Cl",
	},
};
export interface ProgressNodeState {
	id: WorkflowNodeId;
	label: string;
	shortLabel: string;
	status: ProgressStatus;
	visits: number;
	error?: string;
}

export interface ProgressPhaseState extends DecompositionPhase {
	status: ProgressStatus;
	visits: number;
	batchIndex: number;
	phaseIndex: number;
}

export interface ProgressBatchState {
	id: string;
	label: string;
	shortLabel: string;
	index: number;
	status: ProgressStatus;
	parallel: boolean;
	phases: ProgressPhaseState[];
}

export interface ImplementationAreaState {
	expanded: boolean;
	placeholderLabel: string;
	batches: ProgressBatchState[];
	totalPhases: number;
}

export interface ProgressActiveLocation {
	nodeId: WorkflowNodeId;
	batchIndex?: number;
	phaseId?: string;
}

export interface ProgressEventContext {
	batchIndex?: number;
	batchCount?: number;
	phaseId?: string;
	phaseTitle?: string;
	phaseCount?: number;
	qualityRound?: number;
	qualityRounds?: number;
	designReviewNeeded?: boolean;
	workerKind?: string;
	touchedPaths?: string[];
	touchedPathsSummary?: string;
	changedFiles?: string[];
	changedFilesSummary?: string;
	checkerModel?: string;
	checkerModels?: string[];
	discrepancyCount?: number;
	discrepancySummary?: string[];
	recommendation?: string;
	note?: string;
}

export interface ProgressFailureState {
	nodeId?: WorkflowNodeId;
	message: string;
}

export interface ImplementationProgressState {
	nodes: Record<WorkflowNodeId, ProgressNodeState>;
	implementation: ImplementationAreaState;
	activeLocations: ProgressActiveLocation[];
	detailLines: string[];
	currentContext: ProgressEventContext | null;
	edgeTraversalCounts: Record<WorkflowEdgeId, number>;
	finished: boolean;
	failure: ProgressFailureState | null;
}

interface ImplementationProgressEventBase {
	detailLines?: string[];
	context?: ProgressEventContext;
}

export type ImplementationProgressEvent =
	| ({ type: "workflow-start" } & ImplementationProgressEventBase)
	| ({ type: "detail-lines"; lines: string[] } & ImplementationProgressEventBase)
	| ({ type: "decomposer-started" } & ImplementationProgressEventBase)
	| ({ type: "decomposer-completed"; phases: DecompositionPhase[] } & ImplementationProgressEventBase)
	| ({ type: "batches-computed"; phases: DecompositionPhase[]; batches?: DecompositionPhase[][] } & ImplementationProgressEventBase)
	| ({ type: "batch-started"; batchIndex: number } & ImplementationProgressEventBase)
	| ({ type: "batch-completed"; batchIndex: number } & ImplementationProgressEventBase)
	| ({ type: "phase-started"; phaseId: string } & ImplementationProgressEventBase)
	| ({ type: "phase-completed"; phaseId: string } & ImplementationProgressEventBase)
	| ({ type: "cleanup-started" } & ImplementationProgressEventBase)
	| ({ type: "cleanup-completed" } & ImplementationProgressEventBase)
	| ({ type: "design-started" } & ImplementationProgressEventBase)
	| ({ type: "design-completed" } & ImplementationProgressEventBase)
	| ({ type: "design-skipped" } & ImplementationProgressEventBase)
	| ({ type: "checker-started" } & ImplementationProgressEventBase)
	| ({ type: "checker-completed" } & ImplementationProgressEventBase)
	| ({ type: "fix-started" } & ImplementationProgressEventBase)
	| ({ type: "fix-completed" } & ImplementationProgressEventBase)
	| ({ type: "validator-started" } & ImplementationProgressEventBase)
	| ({ type: "validator-completed" } & ImplementationProgressEventBase)
	| ({ type: "finish-started" } & ImplementationProgressEventBase)
	| ({ type: "finish-completed" } & ImplementationProgressEventBase)
	| ({ type: "loop-traversed"; edge: WorkflowEdgeId; count?: number } & ImplementationProgressEventBase)
	| ({ type: "workflow-completed" } & ImplementationProgressEventBase)
	| ({ type: "workflow-failed"; message: string; nodeId?: WorkflowNodeId } & ImplementationProgressEventBase);

export interface WorkflowProgressPresentation {
	stage: string;
	lines: string[];
}

export type WorkflowProgressUpdate = ImplementationProgressEvent & WorkflowProgressPresentation;

export interface LoopLaneDisplay {
	totalTraversals: number;
	visibleLanes: number;
	overflowCount: number;
	badge: string | null;
}

export interface ImplementationProgressLayout {
	width: number;
	compact: boolean;
	abbreviateLabels: boolean;
	expandAllBatches: boolean;
	expandedBatchIndices: number[];
	collapsedBatchIndices: number[];
	maxVisibleLoopLanes: number;
}

export interface ImplementationProgressSnapshotNode {
	id: WorkflowNodeId;
	label: string;
	fullLabel: string;
	shortLabel: string;
	status: ProgressStatus;
	visits: number;
	isActive: boolean;
	error?: string;
}

export interface ImplementationProgressSnapshotPhase {
	id: string;
	label: string;
	fullLabel: string;
	status: ProgressStatus;
	visits: number;
	isActive: boolean;
}

export interface ImplementationProgressSnapshotBatch {
	id: string;
	index: number;
	label: string;
	fullLabel: string;
	shortLabel: string;
	status: ProgressStatus;
	isActive: boolean;
	display: BatchDisplayMode;
	phaseCount: number;
	summaryLabel: string;
	phases: ImplementationProgressSnapshotPhase[];
}

export interface ImplementationProgressSnapshotLoop {
	edge: WorkflowEdgeId;
	traversals: number;
	visibleLanes: number;
	overflowCount: number;
	badge: string | null;
}

export interface ImplementationProgressSnapshot {
	pipeline: ImplementationProgressSnapshotNode[];
	implementation: {
		expanded: boolean;
		placeholderLabel: string;
		batches: ImplementationProgressSnapshotBatch[];
		totalPhases: number;
	};
	activeLocations: ProgressActiveLocation[];
	detailLines: string[];
	context: ProgressEventContext | null;
	loops: ImplementationProgressSnapshotLoop[];
	layout: ImplementationProgressLayout;
	finished: boolean;
	failure: ProgressFailureState | null;
}

export interface ImplementationProgressSnapshotOptions {
	width?: number;
	compactWidth?: number;
	abbreviateWidth?: number;
	maxVisibleLoopLanes?: number;
	expandAllPhasesThreshold?: number;
}

const NODE_META: Record<WorkflowNodeId, { label: string; shortLabel: string }> = {
	decomposer: { label: "Decomposer", shortLabel: "Decomp" },
	implementation: { label: "Implementation", shortLabel: "Implement" },
	cleanup: { label: "Cleanup", shortLabel: "Clean" },
	design: { label: "Design review", shortLabel: "Design" },
	checker: { label: "Checker", shortLabel: "Check" },
	fix: { label: "Fix", shortLabel: "Fix" },
	validator: { label: "Validator", shortLabel: "Validate" },
	finish: { label: "Finish", shortLabel: "Finish" },
};

function createNodes(): Record<WorkflowNodeId, ProgressNodeState> {
	return Object.fromEntries(
		WORKFLOW_NODE_ORDER.map((id) => [
			id,
			{
				id,
				label: NODE_META[id].label,
				shortLabel: NODE_META[id].shortLabel,
				status: "pending",
				visits: 0,
			},
		]),
	) as Record<WorkflowNodeId, ProgressNodeState>;
}

function createEdgeTraversalCounts(): Record<WorkflowEdgeId, number> {
	return Object.fromEntries(WORKFLOW_EDGE_ORDER.map((edge) => [edge, 0])) as Record<WorkflowEdgeId, number>;
}

function copyPhase(phase: ProgressPhaseState): ProgressPhaseState {
	return {
		...phase,
		instructions: [...phase.instructions],
		dependsOn: [...phase.dependsOn],
		touchedPaths: [...phase.touchedPaths],
	};
}

function copyBatch(batch: ProgressBatchState): ProgressBatchState {
	return {
		...batch,
		phases: batch.phases.map(copyPhase),
	};
}

function copyProgressContext(context: ProgressEventContext): ProgressEventContext {
	return {
		...context,
		touchedPaths: context.touchedPaths ? [...context.touchedPaths] : undefined,
		changedFiles: context.changedFiles ? [...context.changedFiles] : undefined,
		checkerModels: context.checkerModels ? [...context.checkerModels] : undefined,
		discrepancySummary: context.discrepancySummary ? [...context.discrepancySummary] : undefined,
	};
}

function cloneState(state: ImplementationProgressState): ImplementationProgressState {
	return {
		nodes: Object.fromEntries(
			WORKFLOW_NODE_ORDER.map((id) => [id, { ...state.nodes[id] }]),
		) as Record<WorkflowNodeId, ProgressNodeState>,
		implementation: {
			...state.implementation,
			batches: state.implementation.batches.map(copyBatch),
		},
		activeLocations: state.activeLocations.map((location) => ({ ...location })),
		detailLines: [...state.detailLines],
		currentContext: state.currentContext ? copyProgressContext(state.currentContext) : null,
		edgeTraversalCounts: { ...state.edgeTraversalCounts },
		finished: state.finished,
		failure: state.failure ? { ...state.failure } : null,
	};
}

function updateProgressPresentation(
	state: ImplementationProgressState,
	event: ImplementationProgressEvent | WorkflowProgressUpdate,
): void {
	const detailLines = event.detailLines ?? ("lines" in event ? event.lines : undefined);
	if (detailLines) state.detailLines = [...detailLines];
	if (event.context) state.currentContext = copyProgressContext(event.context);
}

function normalizeWidth(width: number | undefined): number {
	if (!Number.isFinite(width)) return 100;
	return Math.max(40, Math.floor(width as number));
}

function findPhaseLocation(
	state: ImplementationProgressState,
	phaseId: string,
): { batchIndex: number; phaseIndex: number } | null {
	for (const batch of state.implementation.batches) {
		const phaseIndex = batch.phases.findIndex((phase) => phase.id === phaseId);
		if (phaseIndex >= 0) return { batchIndex: batch.index, phaseIndex };
	}
	return null;
}

function getBatch(state: ImplementationProgressState, batchIndex: number): ProgressBatchState {
	const batch = state.implementation.batches.find((item) => item.index === batchIndex);
	if (!batch) throw new Error(`Unknown batch index: ${batchIndex}`);
	return batch;
}

function markNodeStarted(state: ImplementationProgressState, nodeId: WorkflowNodeId): void {
	const node = state.nodes[nodeId];
	if (node.status !== "active") node.visits += 1;
	node.status = "active";
	node.error = undefined;
}

function markNodeDone(state: ImplementationProgressState, nodeId: WorkflowNodeId): void {
	const node = state.nodes[nodeId];
	if (node.status !== "error") node.status = "done";
	node.error = undefined;
}

function clearStageActiveLocations(state: ImplementationProgressState, nodeId: WorkflowNodeId): void {
	state.activeLocations = state.activeLocations.filter((location) => location.nodeId !== nodeId);
}

function setSingleActiveStage(state: ImplementationProgressState, nodeId: WorkflowNodeId): void {
	for (const active of state.activeLocations) {
		if (active.nodeId !== nodeId && state.nodes[active.nodeId].status === "active") {
			markNodeDone(state, active.nodeId);
		}
	}
	state.activeLocations = [{ nodeId }];
	markNodeStarted(state, nodeId);
}

function setImplementationStatus(state: ImplementationProgressState, status: ProgressStatus): void {
	state.nodes.implementation.status = status;
	if (status !== "error") state.nodes.implementation.error = undefined;
}

function syncBatchStatus(batch: ProgressBatchState): void {
	if (batch.phases.some((phase) => phase.status === "active")) {
		batch.status = "active";
		return;
	}
	if (batch.phases.some((phase) => phase.status === "done")) {
		batch.status = "active";
		return;
	}
	batch.status = "pending";
}

function addActiveLocation(state: ImplementationProgressState, location: ProgressActiveLocation): void {
	const exists = state.activeLocations.some(
		(active) =>
			active.nodeId === location.nodeId &&
			active.batchIndex === location.batchIndex &&
			active.phaseId === location.phaseId,
	);
	if (!exists) state.activeLocations.push(location);
}

function removeActiveLocation(state: ImplementationProgressState, predicate: (location: ProgressActiveLocation) => boolean): void {
	state.activeLocations = state.activeLocations.filter((location) => !predicate(location));
}

function buildProgressBatches(phases: DecompositionPhase[], providedBatches?: DecompositionPhase[][]): ProgressBatchState[] {
	const batches = providedBatches ?? computeExecutionBatches(phases);
	return batches.map((batch, batchIndex) => ({
		id: `batch-${batchIndex + 1}`,
		label: `Batch ${batchIndex + 1}`,
		shortLabel: `B${batchIndex + 1}`,
		index: batchIndex,
		status: "pending",
		parallel: batch.length > 1,
		phases: batch.map((phase, phaseIndex) => ({
			...phase,
			instructions: [...phase.instructions],
			dependsOn: [...phase.dependsOn],
			touchedPaths: [...phase.touchedPaths],
			status: "pending",
			visits: 0,
			batchIndex,
			phaseIndex,
		})),
	}));
}

function getDefaultExpandedBatchIndex(state: ImplementationProgressState): number | null {
	const activeBatch = state.implementation.batches.find((batch) => batch.status === "active");
	if (activeBatch) return activeBatch.index;
	const pendingBatch = state.implementation.batches.find((batch) => batch.status === "pending");
	if (pendingBatch) return pendingBatch.index;
	const lastBatch = state.implementation.batches.at(-1);
	return lastBatch ? lastBatch.index : null;
}

function getActiveBatchIndices(state: ImplementationProgressState): number[] {
	const indices = new Set<number>();
	for (const location of state.activeLocations) {
		if (location.nodeId === "implementation" && typeof location.batchIndex === "number") {
			indices.add(location.batchIndex);
		}
	}
	for (const batch of state.implementation.batches) {
		if (batch.status === "active") indices.add(batch.index);
	}
	return [...indices].sort((a, b) => a - b);
}

function abbreviateText(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	if (maxLength <= 1) return trimmed.slice(0, maxLength);
	return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function getBatchSummaryLabel(batch: ProgressBatchState): string {
	return `${batch.label} • ${batch.phases.length} phase${batch.phases.length === 1 ? "" : "s"}`;
}

export function createImplementationProgressState(
	options: { detailLines?: string[]; context?: ProgressEventContext } = {},
): ImplementationProgressState {
	return {
		nodes: createNodes(),
		implementation: {
			expanded: false,
			placeholderLabel: NODE_META.implementation.label,
			batches: [],
			totalPhases: 0,
		},
		activeLocations: [],
		detailLines: [...(options.detailLines ?? [])],
		currentContext: options.context ? copyProgressContext(options.context) : null,
		edgeTraversalCounts: createEdgeTraversalCounts(),
		finished: false,
		failure: null,
	};
}

export function reduceImplementationProgress(
	state: ImplementationProgressState,
	event: ImplementationProgressEvent | WorkflowProgressUpdate,
): ImplementationProgressState {
	if (event.type === "workflow-start") {
		return createImplementationProgressState({
			detailLines: event.detailLines ?? ("lines" in event ? event.lines : undefined),
			context: event.context,
		});
	}

	const next = cloneState(state);
	if (event.type === "detail-lines") {
		updateProgressPresentation(next, event);
		return next;
	}

	updateProgressPresentation(next, event);

	switch (event.type) {
		case "decomposer-started": {
			setSingleActiveStage(next, "decomposer");
			break;
		}
		case "decomposer-completed": {
			markNodeDone(next, "decomposer");
			clearStageActiveLocations(next, "decomposer");
			next.implementation.totalPhases = event.phases.length;
			break;
		}
		case "batches-computed": {
			next.implementation.batches = buildProgressBatches(event.phases, event.batches);
			next.implementation.totalPhases = event.phases.length;
			next.implementation.expanded = true;
			break;
		}
		case "batch-started": {
			const batch = getBatch(next, event.batchIndex);
			markNodeStarted(next, "implementation");
			batch.status = "active";
			addActiveLocation(next, { nodeId: "implementation", batchIndex: event.batchIndex });
			break;
		}
		case "batch-completed": {
			const batch = getBatch(next, event.batchIndex);
			batch.status = "done";
			for (const phase of batch.phases) {
				if (phase.status !== "error") phase.status = "done";
			}
			removeActiveLocation(
				next,
				(location) => location.nodeId === "implementation" && location.batchIndex === event.batchIndex,
			);
			if (next.implementation.batches.every((item) => item.status === "done")) {
				setImplementationStatus(next, "done");
			}
			break;
		}
		case "phase-started": {
			const location = findPhaseLocation(next, event.phaseId);
			if (!location) throw new Error(`Unknown phase id: ${event.phaseId}`);
			const batch = getBatch(next, location.batchIndex);
			const phase = batch.phases[location.phaseIndex];
			markNodeStarted(next, "implementation");
			if (phase.status !== "active") phase.visits += 1;
			phase.status = "active";
			batch.status = "active";
			removeActiveLocation(
				next,
				(active) => active.nodeId === "implementation" && active.batchIndex === location.batchIndex && !active.phaseId,
			);
			addActiveLocation(next, { nodeId: "implementation", batchIndex: location.batchIndex, phaseId: phase.id });
			break;
		}
		case "phase-completed": {
			const location = findPhaseLocation(next, event.phaseId);
			if (!location) throw new Error(`Unknown phase id: ${event.phaseId}`);
			const batch = getBatch(next, location.batchIndex);
			const phase = batch.phases[location.phaseIndex];
			if (phase.status !== "error") phase.status = "done";
			removeActiveLocation(next, (active) => active.nodeId === "implementation" && active.phaseId === event.phaseId);
			syncBatchStatus(batch);
			const hasBatchActivity = next.activeLocations.some(
				(active) => active.nodeId === "implementation" && active.batchIndex === location.batchIndex,
			);
			if (!hasBatchActivity && batch.status === "active") {
				addActiveLocation(next, { nodeId: "implementation", batchIndex: location.batchIndex });
			}
			break;
		}
		case "cleanup-started": {
			setImplementationStatus(next, next.nodes.implementation.visits > 0 ? "done" : next.nodes.implementation.status);
			removeActiveLocation(next, (location) => location.nodeId === "implementation");
			if (next.nodes.fix.status === "active") markNodeDone(next, "fix");
			if (next.nodes.finish.status === "active") markNodeDone(next, "finish");
			setSingleActiveStage(next, "cleanup");
			break;
		}
		case "cleanup-completed": {
			markNodeDone(next, "cleanup");
			clearStageActiveLocations(next, "cleanup");
			break;
		}
		case "design-started": {
			if (next.nodes.cleanup.status === "active") markNodeDone(next, "cleanup");
			setSingleActiveStage(next, "design");
			break;
		}
		case "design-completed": {
			markNodeDone(next, "design");
			clearStageActiveLocations(next, "design");
			break;
		}
		case "design-skipped": {
			if (next.nodes.design.status !== "done") {
				next.nodes.design.status = "skipped";
				next.nodes.design.error = undefined;
			}
			clearStageActiveLocations(next, "design");
			break;
		}
		case "checker-started": {
			setImplementationStatus(next, next.nodes.implementation.visits > 0 ? "done" : next.nodes.implementation.status);
			removeActiveLocation(next, (location) => location.nodeId === "implementation");
			if (next.nodes.cleanup.status === "active") markNodeDone(next, "cleanup");
			if (next.nodes.design.status === "active") markNodeDone(next, "design");
			setSingleActiveStage(next, "checker");
			break;
		}
		case "checker-completed": {
			markNodeDone(next, "checker");
			clearStageActiveLocations(next, "checker");
			break;
		}
		case "fix-started": {
			if (next.nodes.cleanup.status === "active") markNodeDone(next, "cleanup");
			if (next.nodes.design.status === "active") markNodeDone(next, "design");
			if (next.nodes.checker.status === "active") markNodeDone(next, "checker");
			setSingleActiveStage(next, "fix");
			break;
		}
		case "fix-completed": {
			markNodeDone(next, "fix");
			clearStageActiveLocations(next, "fix");
			break;
		}
		case "validator-started": {
			if (next.nodes.cleanup.status === "active") markNodeDone(next, "cleanup");
			if (next.nodes.design.status === "active") markNodeDone(next, "design");
			if (next.nodes.checker.status === "active") markNodeDone(next, "checker");
			if (next.nodes.fix.status === "active") markNodeDone(next, "fix");
			if (next.nodes.finish.status === "active") markNodeDone(next, "finish");
			setSingleActiveStage(next, "validator");
			break;
		}
		case "validator-completed": {
			markNodeDone(next, "validator");
			clearStageActiveLocations(next, "validator");
			break;
		}
		case "finish-started": {
			markNodeDone(next, "validator");
			setSingleActiveStage(next, "finish");
			break;
		}
		case "finish-completed": {
			markNodeDone(next, "finish");
			clearStageActiveLocations(next, "finish");
			break;
		}
		case "loop-traversed": {
			next.edgeTraversalCounts[event.edge] += Math.max(1, event.count ?? 1);
			break;
		}
		case "workflow-completed": {
			for (const location of next.activeLocations) {
				if (next.nodes[location.nodeId].status === "active") markNodeDone(next, location.nodeId);
			}
			next.activeLocations = [];
			next.finished = true;
			break;
		}
		case "workflow-failed": {
			for (const location of next.activeLocations) {
				if (next.nodes[location.nodeId].status === "active") markNodeDone(next, location.nodeId);
			}
			next.activeLocations = [];
			next.finished = true;
			next.failure = {
				nodeId: event.nodeId,
				message: event.message,
			};
			if (event.nodeId) {
				next.nodes[event.nodeId].status = "error";
				next.nodes[event.nodeId].error = event.message;
			}
			break;
		}
		default:
			break;
	}

	return next;
}

export function describeLoopLanes(totalTraversals: number, maxVisibleLanes = 3): LoopLaneDisplay {
	const normalizedTraversals = Math.max(0, Math.floor(totalTraversals));
	const normalizedMaxVisibleLanes = Math.max(1, Math.floor(maxVisibleLanes));
	const visibleLanes = Math.min(normalizedTraversals, normalizedMaxVisibleLanes);
	const overflowCount = Math.max(0, normalizedTraversals - visibleLanes);
	return {
		totalTraversals: normalizedTraversals,
		visibleLanes,
		overflowCount,
		badge: normalizedTraversals > 1 ? `×${normalizedTraversals}` : null,
	};
}

export function decideImplementationProgressLayout(
	state: ImplementationProgressState,
	options: ImplementationProgressSnapshotOptions = {},
): ImplementationProgressLayout {
	const width = normalizeWidth(options.width);
	const compactWidth = normalizeWidth(options.compactWidth ?? 96);
	const abbreviateWidth = normalizeWidth(options.abbreviateWidth ?? 72);
	const totalPhases = state.implementation.totalPhases;
	const batchCount = state.implementation.batches.length;
	const expandAllPhasesThreshold = Math.max(1, options.expandAllPhasesThreshold ?? 5);
	const compact = width < compactWidth || totalPhases > 6 || batchCount > 3;
	const abbreviateLabels = width < abbreviateWidth || totalPhases > 8;
	const expandAllBatches = !compact && totalPhases <= expandAllPhasesThreshold && batchCount <= 3;
	const allBatchIndices = state.implementation.batches.map((batch) => batch.index);
	const activeBatchIndices = getActiveBatchIndices(state);
	const fallbackBatchIndex = getDefaultExpandedBatchIndex(state);
	const expandedBatchIndices = expandAllBatches
		? allBatchIndices
		: activeBatchIndices.length > 0
			? activeBatchIndices
			: fallbackBatchIndex === null
				? []
				: [fallbackBatchIndex];
	const collapsedBatchIndices = allBatchIndices.filter((index) => !expandedBatchIndices.includes(index));

	return {
		width,
		compact,
		abbreviateLabels,
		expandAllBatches,
		expandedBatchIndices,
		collapsedBatchIndices,
		maxVisibleLoopLanes: Math.max(1, Math.min(3, options.maxVisibleLoopLanes ?? 3)),
	};
}

export function buildImplementationProgressSnapshot(
	state: ImplementationProgressState,
	options: ImplementationProgressSnapshotOptions = {},
): ImplementationProgressSnapshot {
	const layout = decideImplementationProgressLayout(state, options);
	const nodeLabel = (node: ProgressNodeState): string =>
		layout.abbreviateLabels ? node.shortLabel : node.label;
	const batches = state.implementation.batches.map((batch) => {
		const display: BatchDisplayMode = layout.expandedBatchIndices.includes(batch.index) ? "expanded" : "collapsed";
		const phases =
			display === "expanded"
				? batch.phases.map((phase) => ({
					id: phase.id,
					label: layout.abbreviateLabels ? abbreviateText(phase.title, 18) : phase.title,
					fullLabel: phase.title,
					status: phase.status,
					visits: phase.visits,
					isActive: state.activeLocations.some((active) => active.phaseId === phase.id),
				}))
				: [];

		return {
			id: batch.id,
			index: batch.index,
			label: layout.abbreviateLabels ? batch.shortLabel : batch.label,
			fullLabel: batch.label,
			shortLabel: batch.shortLabel,
			status: batch.status,
			isActive: getActiveBatchIndices(state).includes(batch.index),
			display,
			phaseCount: batch.phases.length,
			summaryLabel: layout.abbreviateLabels
				? abbreviateText(getBatchSummaryLabel(batch), 20)
				: getBatchSummaryLabel(batch),
			phases,
		};
	});

	return {
		pipeline: WORKFLOW_NODE_ORDER.map((id) => ({
			id,
			label: nodeLabel(state.nodes[id]),
			fullLabel: state.nodes[id].label,
			shortLabel: state.nodes[id].shortLabel,
			status: state.nodes[id].status,
			visits: state.nodes[id].visits,
			isActive: state.activeLocations.some((location) => location.nodeId === id),
			error: state.nodes[id].error,
		})),
		implementation: {
			expanded: state.implementation.expanded,
			placeholderLabel: layout.abbreviateLabels
				? state.nodes.implementation.shortLabel
				: state.implementation.placeholderLabel,
			batches,
			totalPhases: state.implementation.totalPhases,
		},
		activeLocations: state.activeLocations.map((location) => ({ ...location })),
		detailLines: [...state.detailLines],
		context: state.currentContext ? copyProgressContext(state.currentContext) : null,
		loops: WORKFLOW_EDGE_ORDER.map((edge) => {
			const loop = describeLoopLanes(state.edgeTraversalCounts[edge], layout.maxVisibleLoopLanes);
			return {
				edge,
				traversals: loop.totalTraversals,
				visibleLanes: loop.visibleLanes,
				overflowCount: loop.overflowCount,
				badge: loop.badge,
			};
		}),
		layout,
		finished: state.finished,
		failure: state.failure ? { ...state.failure } : null,
	};
}

