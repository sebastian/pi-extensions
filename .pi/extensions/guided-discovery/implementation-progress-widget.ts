import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { padToWidth, truncateToWidth, visibleWidth } from "./tui-compat.ts";
import {
	WORKFLOW_EDGE_META,
	type ImplementationProgressSnapshot,
	type ImplementationProgressSnapshotBatch,
	type ImplementationProgressSnapshotLoop,
	type ImplementationProgressSnapshotNode,
	type ImplementationProgressSnapshotOptions,
	type ImplementationProgressSnapshotPhase,
	type ImplementationProgressState,
	type ProgressStatus,
	type WorkflowNodeId,
	buildImplementationProgressSnapshot,
} from "./implementation-progress.ts";

interface NodePosition {
	start: number;
	end: number;
	center: number;
}

interface HorizontalPipelineLayout {
	line: string;
	positions: Record<WorkflowNodeId, NodePosition>;
}

export interface ImplementationProgressWidgetOptions extends ImplementationProgressSnapshotOptions {
	maxDetailLines?: number;
	title?: string;
}

const DEFAULT_TITLE = "Guided implementation";
const MAX_DETAIL_LINES = 4;
const NARROW_LAYOUT_WIDTH = 78;
const LOOP_OVERLAY_EDGES = new Set(["cleanup->fix", "design->fix", "checker->fix", "fix->cleanup", "fix->checker"]);

function statusColor(status: ProgressStatus): ThemeColor {
	switch (status) {
		case "active":
			return "accent";
		case "done":
			return "success";
		case "error":
			return "error";
		case "skipped":
			return "muted";
		default:
			return "dim";
	}
}

function statusGlyph(status: ProgressStatus): string {
	switch (status) {
		case "active":
			return "◉";
		case "done":
			return "●";
		case "error":
			return "✕";
		case "skipped":
			return "◌";
		default:
			return "○";
	}
}

function styleToken(theme: Theme, color: ThemeColor, text: string, bold = false): string {
	return theme.fg(color, bold ? theme.bold(text) : text);
}

function renderVisitBadge(theme: Theme, visits: number, active = false): string {
	if (visits <= 1) return "";
	return theme.fg(active ? "accent" : "muted", ` ×${visits}`);
}

function renderNodeChip(theme: Theme, node: ImplementationProgressSnapshotNode): string {
	const color = statusColor(node.status);
	const text = `${statusGlyph(node.status)} ${node.label}`;
	return `${styleToken(theme, color, text, node.status === "active")}${renderVisitBadge(theme, node.visits, node.isActive)}`;
}

function renderBatchChip(theme: Theme, batch: ImplementationProgressSnapshotBatch): string {
	const color = statusColor(batch.status);
	const text = `${statusGlyph(batch.status)} ${batch.label}`;
	return `${styleToken(theme, color, text, batch.isActive)}${batch.isActive ? theme.fg("accent", " ▸") : ""}`;
}

function renderPhaseChip(theme: Theme, phase: ImplementationProgressSnapshotPhase): string {
	const color = statusColor(phase.status);
	const glyph = phase.status === "pending" ? "◦" : statusGlyph(phase.status);
	const text = `${glyph} ${phase.label}`;
	return `${styleToken(theme, color, text, phase.isActive)}${renderVisitBadge(theme, phase.visits, phase.isActive)}`;
}

function renderLaneSummary(loop: ImplementationProgressSnapshotLoop): string {
	if (loop.visibleLanes <= 0) return "";
	return "║".repeat(loop.visibleLanes);
}

function renderBatchSummary(theme: Theme, batch: ImplementationProgressSnapshotBatch): string {
	return theme.fg("muted", ` • ${batch.phaseCount} phase${batch.phaseCount === 1 ? "" : "s"}`);
}

function trimRight(text: string): string {
	return text.replace(/\s+$/u, "");
}

function stylePipelineConnector(theme: Theme, from: ImplementationProgressSnapshotNode, to: ImplementationProgressSnapshotNode): string {
	let color: ThemeColor = "borderMuted";
	let connector = "──╼";
	if (from.status === "error" || to.status === "error") color = "error";
	else if (from.isActive || to.isActive || from.status === "active" || to.status === "active") color = "accent";
	else if (from.status === "done" && to.status === "done") color = "success";
	else if (from.status === "done" || to.status === "done") color = "borderAccent";
	if (from.visits > 1 || to.visits > 1) connector = "══╼";
	return theme.fg(color, ` ${connector} `);
}

function buildHorizontalPipeline(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): HorizontalPipelineLayout | null {
	let line = "";
	const positions = {} as Record<WorkflowNodeId, NodePosition>;

	for (let index = 0; index < snapshot.pipeline.length; index++) {
		const node = snapshot.pipeline[index]!;
		const start = visibleWidth(line);
		line += renderNodeChip(theme, node);
		const end = Math.max(start, visibleWidth(line) - 1);
		positions[node.id] = {
			start,
			end,
			center: Math.floor((start + end) / 2),
		};
		const next = snapshot.pipeline[index + 1];
		if (next) line += stylePipelineConnector(theme, node, next);
	}

	return visibleWidth(line) <= innerWidth ? { line, positions } : null;
}

function renderWorkerSubtree(
	theme: Theme,
	snapshot: ImplementationProgressSnapshot,
	innerWidth: number,
	anchor: number,
): string[] {
	const lines: string[] = [];
	const branchIndent = Math.max(0, Math.min(anchor, Math.max(0, innerWidth - 8)));
	const pad = " ".repeat(branchIndent);

	if (!snapshot.implementation.expanded) {
		lines.push(
			trimRight(
				truncateToWidth(
					`${pad}${theme.fg("borderMuted", "╰─ ")}${theme.fg("dim", `${snapshot.implementation.placeholderLabel} awaiting decomposition`)}`,
					innerWidth,
					"…",
				),
			),
		);
		return lines;
	}

	lines.push(trimRight(truncateToWidth(`${pad}${theme.fg("borderAccent", "│")}`, innerWidth, "…")));
	for (let batchIndex = 0; batchIndex < snapshot.implementation.batches.length; batchIndex++) {
		const batch = snapshot.implementation.batches[batchIndex]!;
		const isLastBatch = batchIndex === snapshot.implementation.batches.length - 1;
		const batchBranch = theme.fg("borderAccent", `${isLastBatch ? "╰" : "├"}─ `);
		const batchLine =
			batch.display === "collapsed"
				? `${pad}${batchBranch}${renderBatchChip(theme, batch)}${renderBatchSummary(theme, batch)}`
				: `${pad}${batchBranch}${renderBatchChip(theme, batch)}`;
		lines.push(trimRight(truncateToWidth(batchLine, innerWidth, "…")));

		if (batch.display !== "expanded") continue;

		for (let phaseIndex = 0; phaseIndex < batch.phases.length; phaseIndex++) {
			const phase = batch.phases[phaseIndex]!;
			const isLastPhase = phaseIndex === batch.phases.length - 1;
			const stem = isLastBatch ? "  " : "│ ";
			const phaseBranch = theme.fg("borderMuted", `${stem}${isLastPhase ? "╰" : "├"}─ `);
			const details = phase.fullLabel !== phase.label ? theme.fg("muted", ` • ${phase.fullLabel}`) : "";
			lines.push(trimRight(truncateToWidth(`${pad}${phaseBranch}${renderPhaseChip(theme, phase)}${details}`, innerWidth, "…")));
		}
	}

	return lines;
}

function placePlainText(cells: string[], start: number, text: string): boolean {
	if (start < 0 || start + text.length > cells.length) return false;
	for (let index = 0; index < text.length; index++) {
		cells[start + index] = text[index]!;
	}
	return true;
}

function renderLoopStrip(
	theme: Theme,
	innerWidth: number,
	layout: HorizontalPipelineLayout,
	loop: ImplementationProgressSnapshotLoop,
): string[] {
	if (loop.visibleLanes <= 0) return [];
	const meta = WORKFLOW_EDGE_META[loop.edge];
	const from = layout.positions[meta.from];
	const to = layout.positions[meta.to];
	if (!from || !to) return [];

	const left = Math.max(0, Math.min(from.center, to.center));
	const right = Math.min(innerWidth - 1, Math.max(from.center, to.center));
	if (left >= right) return [];

	const forward = from.center <= to.center;
	const color: ThemeColor = loop.traversals > 1 ? "accent" : "borderAccent";
	const lines: string[] = [];
	const badge = loop.badge ?? "";

	for (let laneIndex = 0; laneIndex < loop.visibleLanes; laneIndex++) {
		const cells = Array.from({ length: innerWidth }, () => " ");
		const leftCap = forward ? (laneIndex === 0 ? "╭" : laneIndex === loop.visibleLanes - 1 ? "╰" : "├") : "◀";
		const rightCap = forward ? "▶" : laneIndex === 0 ? "╮" : laneIndex === loop.visibleLanes - 1 ? "╯" : "┤";
		cells[left] = leftCap;
		for (let x = left + 1; x < right; x++) cells[x] = "═";
		cells[right] = rightCap;

		if (laneIndex === 0 && badge) {
			const badgeStart = forward ? right + 2 : Math.max(0, left - badge.length - 2);
			placePlainText(cells, badgeStart, badge);
		}

		lines.push(theme.fg(color, trimRight(cells.join(""))));
	}

	return lines;
}

function shouldRenderLoop(loop: ImplementationProgressSnapshotLoop): boolean {
	return loop.traversals > 0 && LOOP_OVERLAY_EDGES.has(loop.edge);
}

function renderLoopSummary(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): string[] {
	const touchedLoops = snapshot.loops.filter(shouldRenderLoop);
	if (touchedLoops.length === 0) return [];
	const summary = touchedLoops
		.map((loop) => {
			const meta = WORKFLOW_EDGE_META[loop.edge];
			const lanes = renderLaneSummary(loop);
			const badge = loop.badge ? ` ${loop.badge}` : "";
			return `${meta.shortLabel} ${lanes}${badge}`.trim();
		})
		.join("  •  ");
	return [theme.fg("muted", truncateToWidth(`loops ▸ ${summary}`, innerWidth, "…"))];
}

function collectPhaseStats(snapshot: ImplementationProgressSnapshot): { completed: number; total: number } {
	let completed = 0;
	let total = 0;
	for (const batch of snapshot.implementation.batches) {
		for (const phase of batch.phases) {
			total += 1;
			if (phase.status === "done") completed += 1;
		}
	}
	return { completed, total: snapshot.implementation.totalPhases || total };
}

function summarizeActiveLocation(snapshot: ImplementationProgressSnapshot): string {
	const activePhases: string[] = [];
	for (const batch of snapshot.implementation.batches) {
		for (const phase of batch.phases) {
			if (phase.isActive) activePhases.push(`${batch.shortLabel}: ${phase.fullLabel}`);
		}
	}
	if (activePhases.length > 0) {
		return activePhases.length > 2
			? `${activePhases.slice(0, 2).join(", ")} +${activePhases.length - 2}`
			: activePhases.join(", ");
	}

	const activeBatch = snapshot.implementation.batches.find((batch) => batch.isActive);
	if (activeBatch) return `${activeBatch.fullLabel}`;
	const activeNode = snapshot.pipeline.find((node) => node.isActive);
	if (activeNode) return activeNode.fullLabel;
	if (snapshot.failure?.nodeId) {
		const failedNode = snapshot.pipeline.find((node) => node.id === snapshot.failure?.nodeId);
		return failedNode ? `failed at ${failedNode.fullLabel}` : "failed";
	}
	return snapshot.finished ? "complete" : "waiting";
}

function renderTelemetry(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): string[] {
	const phaseStats = collectPhaseStats(snapshot);
	const revisitedNodes = snapshot.pipeline.filter((node) => node.visits > 1).length;
	const touchedLoops = snapshot.loops.filter(shouldRenderLoop).length;
	const summaryParts = [
		theme.fg("accent", `active ▸ ${summarizeActiveLocation(snapshot)}`),
		theme.fg("muted", `phases ${phaseStats.completed}/${phaseStats.total}`),
	];
	if (touchedLoops > 0) summaryParts.push(theme.fg("muted", `retries ${touchedLoops}`));
	if (revisitedNodes > 0) summaryParts.push(theme.fg("muted", `revisited ${revisitedNodes}`));
	return [truncateToWidth(summaryParts.join(theme.fg("dim", "  •  ")), innerWidth, "…")];
}

function renderDetailLines(
	theme: Theme,
	snapshot: ImplementationProgressSnapshot,
	innerWidth: number,
	maxDetailLines: number,
): string[] {
	return snapshot.detailLines
		.slice(0, Math.max(0, maxDetailLines))
		.map((line) => truncateToWidth(`${theme.fg("dim", "· ")}${theme.fg("muted", line)}`, innerWidth, "…"));
}

function renderHorizontalGraph(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): string[] | null {
	const pipeline = buildHorizontalPipeline(theme, snapshot, innerWidth);
	if (!pipeline) return null;

	const lines: string[] = [pipeline.line];
	const implementationAnchor = Math.max(0, Math.min(pipeline.positions.implementation.start + 2, innerWidth - 1));
	lines.push(...renderWorkerSubtree(theme, snapshot, innerWidth, implementationAnchor));
	for (const loop of snapshot.loops.filter(shouldRenderLoop)) {
		lines.push(...renderLoopStrip(theme, innerWidth, pipeline, loop));
	}
	lines.push(...renderLoopSummary(theme, snapshot, innerWidth));
	return lines;
}

function renderCollapsedBatchLine(theme: Theme, batch: ImplementationProgressSnapshotBatch, prefix: string, innerWidth: number): string {
	const text = `${prefix}${renderBatchChip(theme, batch)}${renderBatchSummary(theme, batch)}`;
	return truncateToWidth(text, innerWidth, "…");
}

function renderExpandedBatchLines(
	theme: Theme,
	batch: ImplementationProgressSnapshotBatch,
	prefix: string,
	innerWidth: number,
): string[] {
	const lines = [truncateToWidth(`${prefix}${renderBatchChip(theme, batch)}`, innerWidth, "…")];
	for (let index = 0; index < batch.phases.length; index++) {
		const phase = batch.phases[index]!;
		const branch = theme.fg("borderMuted", `${index === batch.phases.length - 1 ? "   │  ╰─ " : "   │  ├─ "}`);
		const detail = phase.fullLabel !== phase.label ? theme.fg("muted", ` • ${phase.fullLabel}`) : "";
		lines.push(truncateToWidth(`${branch}${renderPhaseChip(theme, phase)}${detail}`, innerWidth, "…"));
	}
	return lines;
}

function renderCompactLoopLegend(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): string[] {
	return snapshot.loops
		.filter(shouldRenderLoop)
		.map((loop) => {
			const meta = WORKFLOW_EDGE_META[loop.edge];
			const lanes = renderLaneSummary(loop) || "·";
			const badge = loop.badge ? ` ${loop.badge}` : "";
			return truncateToWidth(
				`${theme.fg("accent", "↺ ")}${theme.fg("muted", meta.shortLabel)} ${theme.fg("borderAccent", lanes)}${theme.fg("muted", badge)}`,
				innerWidth,
				"…",
			);
		});
}

function renderVerticalGraph(theme: Theme, snapshot: ImplementationProgressSnapshot, innerWidth: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < snapshot.pipeline.length; index++) {
		const node = snapshot.pipeline[index]!;
		const prefix = index === 0 ? "" : theme.fg("borderMuted", "└─ ");
		lines.push(truncateToWidth(`${prefix}${renderNodeChip(theme, node)}`, innerWidth, "…"));

		if (node.id !== "implementation") continue;
		if (!snapshot.implementation.expanded) {
			lines.push(
				truncateToWidth(
					`${theme.fg("borderMuted", "   ╰─ ")}${theme.fg("dim", `${snapshot.implementation.placeholderLabel} awaiting decomposition`)}`,
					innerWidth,
					"…",
				),
			);
			continue;
		}

		for (const batch of snapshot.implementation.batches) {
			const batchPrefix = theme.fg("borderAccent", "   ├─ ");
			if (batch.display === "collapsed") {
				lines.push(renderCollapsedBatchLine(theme, batch, batchPrefix, innerWidth));
				continue;
			}
			lines.push(...renderExpandedBatchLines(theme, batch, batchPrefix, innerWidth));
		}
	}
	lines.push(...renderCompactLoopLegend(theme, snapshot, innerWidth));
	return lines;
}

function getHeaderStatus(snapshot: ImplementationProgressSnapshot): string {
	if (snapshot.failure) return "failed";
	if (snapshot.finished) return "complete";
	if (snapshot.pipeline.some((node) => node.isActive) || snapshot.implementation.batches.some((batch) => batch.isActive)) {
		return "active";
	}
	return "queued";
}

function renderTopBorder(theme: Theme, title: string, status: string, innerWidth: number): string {
	let titleText = theme.fg("accent", ` ${theme.bold(title)} `);
	let statusText = theme.fg(status === "failed" ? "error" : status === "complete" ? "success" : "muted", ` ${status} `);

	if (visibleWidth(titleText) + visibleWidth(statusText) > innerWidth) statusText = "";
	if (visibleWidth(titleText) > innerWidth) titleText = truncateToWidth(titleText, innerWidth, "…");
	const fillerWidth = Math.max(0, innerWidth - visibleWidth(titleText) - visibleWidth(statusText));
	return theme.fg("border", "╭") + titleText + theme.fg("border", "─".repeat(fillerWidth)) + statusText + theme.fg("border", "╮");
}

function renderBottomBorder(theme: Theme, innerWidth: number): string {
	return theme.fg("border", `╰${"═".repeat(innerWidth)}╯`);
}

function frameBodyLines(theme: Theme, lines: string[], innerWidth: number): string[] {
	return lines.map((line) => {
		const fitted = padToWidth(truncateToWidth(line, innerWidth, "…", true), innerWidth);
		return theme.fg("border", "│") + fitted + theme.fg("border", "│");
	});
}

export function renderImplementationProgressSnapshot(
	theme: Theme,
	snapshot: ImplementationProgressSnapshot,
	width: number,
	options: ImplementationProgressWidgetOptions = {},
): string[] {
	const innerWidth = Math.max(1, Math.floor(width) - 2);
	const title = options.title ?? DEFAULT_TITLE;
	const maxDetailLines = options.maxDetailLines ?? MAX_DETAIL_LINES;
	const graphLines =
		innerWidth < NARROW_LAYOUT_WIDTH || snapshot.layout.compact
			? renderVerticalGraph(theme, snapshot, innerWidth)
			: (renderHorizontalGraph(theme, snapshot, innerWidth) ?? renderVerticalGraph(theme, snapshot, innerWidth));
	const bodyLines = [
		...graphLines,
		"",
		...renderTelemetry(theme, snapshot, innerWidth),
		...renderDetailLines(theme, snapshot, innerWidth, maxDetailLines),
	];
	if (snapshot.failure?.message) {
		bodyLines.push(truncateToWidth(`${theme.fg("error", "! ")}${theme.fg("error", snapshot.failure.message)}`, innerWidth, "…"));
	}
	return [
		renderTopBorder(theme, title, getHeaderStatus(snapshot), innerWidth),
		...frameBodyLines(theme, bodyLines, innerWidth),
		renderBottomBorder(theme, innerWidth),
	];
}

export function renderImplementationProgressWidget(
	theme: Theme,
	state: ImplementationProgressState,
	width: number,
	options: ImplementationProgressWidgetOptions = {},
): string[] {
	const snapshot = buildImplementationProgressSnapshot(state, {
		...options,
		width: Math.max(1, Math.floor(width) - 2),
	});
	return renderImplementationProgressSnapshot(theme, snapshot, width, options);
}

class ImplementationProgressWidgetComponent implements Component {
	private cachedWidth?: number;
	private cachedState?: ImplementationProgressState;
	private cachedLines?: string[];
	private readonly theme: Theme;
	private readonly getState: () => ImplementationProgressState;
	private readonly options: ImplementationProgressWidgetOptions;

	constructor(theme: Theme, getState: () => ImplementationProgressState, options: ImplementationProgressWidgetOptions) {
		this.theme = theme;
		this.getState = getState;
		this.options = options;
	}

	render(width: number): string[] {
		const state = this.getState();
		if (this.cachedLines && this.cachedWidth === width && this.cachedState === state) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedState = state;
		this.cachedLines = renderImplementationProgressWidget(this.theme, state, width, this.options);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedState = undefined;
		this.cachedLines = undefined;
	}
}

export function createImplementationProgressWidget(
	getState: () => ImplementationProgressState,
	options: ImplementationProgressWidgetOptions = {},
): (tui: TUI, theme: Theme) => Component {
	return (_tui: TUI, theme: Theme) => new ImplementationProgressWidgetComponent(theme, getState, options);
}
