export type VimMode = "normal" | "insert";
export type VimOperatorKind = "delete" | "change" | "yank";

export interface Cursor {
	line: number;
	col: number;
}

export interface BufferState {
	lines: string[];
	cursor: Cursor;
}

export interface VimBuffer {
	getState(): BufferState;
	setCursor(cursor: Cursor): void;
	applyState(state: BufferState): void;
	undo(): void;
}

export type VimRegister =
	| { kind: "char"; text: string }
	| { kind: "line"; lines: string[] };

interface PendingOperator {
	kind: VimOperatorKind;
	key: "d" | "c" | "y";
	count: number;
	motionCountBuffer: string;
}

interface PendingFind {
	key: "f" | "F" | "t" | "T";
	count: number;
	operator?: PendingOperator;
}

interface PendingReplace {
	count: number;
}

interface PendingTextObject {
	operator: PendingOperator;
	kind: "inner" | "around";
	count: number;
}

interface LastFind {
	char: string;
	direction: "forward" | "backward";
	until: boolean;
}

interface Motion {
	target: Cursor;
	inclusive?: boolean;
	linewise?: boolean;
}

interface SelectionRange {
	start: number;
	end: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function segmentGraphemes(text: string): Intl.SegmentData[] {
	return [...graphemeSegmenter.segment(text)];
}

function isDigit(key: string): boolean {
	return key.length === 1 && key >= "0" && key <= "9";
}

function cloneCursor(cursor: Cursor): Cursor {
	return { line: cursor.line, col: cursor.col };
}

function cloneState(state: BufferState): BufferState {
	return { lines: [...state.lines], cursor: cloneCursor(state.cursor) };
}

function ensureLines(lines: string[]): string[] {
	return lines.length === 0 ? [""] : lines;
}

function linesToText(lines: readonly string[]): string {
	return lines.join("\n");
}

function splitText(text: string): string[] {
	return ensureLines(text.split("\n"));
}

function getLine(lines: readonly string[], line: number): string {
	return lines[Math.max(0, Math.min(line, lines.length - 1))] ?? "";
}

function currentLine(state: BufferState): string {
	return getLine(state.lines, state.cursor.line);
}

function leadingIndent(line: string): string {
	const match = line.match(/^[ \t]*/u);
	return match?.[0] ?? "";
}

function firstNonBlankCol(line: string): number {
	for (const grapheme of segmentGraphemes(line)) {
		if (!/^\s+$/u.test(grapheme.segment)) return grapheme.index;
	}
	return 0;
}

function lastNonBlankCol(line: string): number {
	const graphemes = segmentGraphemes(line);
	for (let index = graphemes.length - 1; index >= 0; index--) {
		const grapheme = graphemes[index];
		if (grapheme && !/^\s+$/u.test(grapheme.segment)) return grapheme.index;
	}
	return 0;
}

function lastGraphemeCol(line: string): number {
	const graphemes = segmentGraphemes(line);
	return graphemes.length === 0 ? 0 : graphemes[graphemes.length - 1]!.index;
}

function nextGraphemeCol(line: string, col: number): number {
	const remainder = line.slice(Math.max(0, Math.min(col, line.length)));
	const next = segmentGraphemes(remainder)[0];
	return next ? col + next.segment.length : line.length;
}

function previousGraphemeCol(line: string, col: number): number {
	const prefix = line.slice(0, Math.max(0, Math.min(col, line.length)));
	const graphemes = segmentGraphemes(prefix);
	return graphemes.length === 0 ? 0 : col - graphemes[graphemes.length - 1]!.segment.length;
}

function normalizeBoundary(line: string, col: number, allowLineEnd: boolean): number {
	const clamped = Math.max(0, Math.min(col, line.length));
	if (allowLineEnd && clamped === line.length) return clamped;
	let boundary = 0;
	for (const grapheme of segmentGraphemes(line)) {
		if (grapheme.index > clamped) break;
		boundary = grapheme.index;
		if (grapheme.index === clamped) return clamped;
	}
	return boundary;
}

function normalizeNormalCursor(lines: readonly string[], cursor: Cursor): Cursor {
	const lineIndex = Math.max(0, Math.min(cursor.line, lines.length - 1));
	const line = getLine(lines, lineIndex);
	if (line.length === 0) return { line: lineIndex, col: 0 };
	let col = Math.max(0, Math.min(cursor.col, line.length));
	if (col === line.length) col = lastGraphemeCol(line);
	else col = normalizeBoundary(line, col, false);
	return { line: lineIndex, col };
}

function normalizeInsertCursor(lines: readonly string[], cursor: Cursor): Cursor {
	const lineIndex = Math.max(0, Math.min(cursor.line, lines.length - 1));
	const line = getLine(lines, lineIndex);
	const col = normalizeBoundary(line, cursor.col, true);
	return { line: lineIndex, col };
}

function stateOffset(lines: readonly string[], cursor: Cursor): number {
	let offset = 0;
	for (let lineIndex = 0; lineIndex < cursor.line; lineIndex++) {
		offset += (lines[lineIndex] ?? "").length;
		offset += 1;
	}
	return offset + cursor.col;
}

function cursorFromOffset(lines: readonly string[], offset: number): Cursor {
	let remaining = Math.max(0, offset);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		if (remaining <= line.length) return { line: lineIndex, col: remaining };
		remaining -= line.length;
		if (lineIndex < lines.length - 1) {
			if (remaining === 0) return { line: lineIndex + 1, col: 0 };
			remaining -= 1;
		}
	}
	const lastLine = Math.max(0, lines.length - 1);
	return { line: lastLine, col: getLine(lines, lastLine).length };
}

function cursorAtLastNormalPosition(lines: readonly string[]): Cursor {
	const lastLine = Math.max(0, lines.length - 1);
	return normalizeNormalCursor(lines, { line: lastLine, col: getLine(lines, lastLine).length });
}

function nextGraphemeOffset(text: string, offset: number): number {
	const next = segmentGraphemes(text.slice(Math.max(0, Math.min(offset, text.length))))[0];
	return next ? Math.min(text.length, offset + next.segment.length) : text.length;
}

function compareCursors(lines: readonly string[], left: Cursor, right: Cursor): number {
	const leftOffset = stateOffset(lines, left);
	const rightOffset = stateOffset(lines, right);
	return leftOffset === rightOffset ? 0 : leftOffset < rightOffset ? -1 : 1;
}

function charClass(segment: string, bigWord: boolean): "space" | "word" | "punct" {
	if (/^\s+$/u.test(segment)) return "space";
	if (bigWord) return "word";
	return /^[\p{L}\p{N}_]+$/u.test(segment) ? "word" : "punct";
}

function graphemeIndexAtOrAfter(segments: Intl.SegmentData[], offset: number): number {
	for (let index = 0; index < segments.length; index++) {
		if ((segments[index]?.index ?? 0) >= offset) return index;
	}
	return segments.length;
}

function charUnderCursor(state: BufferState): string | undefined {
	const line = currentLine(state);
	if (line.length === 0 || state.cursor.col >= line.length) return undefined;
	return segmentGraphemes(line.slice(state.cursor.col))[0]?.segment;
}

function moveLeftWithinLine(state: BufferState, count: number): Cursor {
	const line = currentLine(state);
	let col = state.cursor.col;
	for (let step = 0; step < count; step++) {
		if (col === 0) break;
		col = previousGraphemeCol(line, col);
	}
	return { line: state.cursor.line, col };
}

function moveRightWithinLine(state: BufferState, count: number): Cursor {
	const line = currentLine(state);
	if (line.length === 0) return { line: state.cursor.line, col: 0 };
	let col = state.cursor.col;
	for (let step = 0; step < count; step++) {
		const next = nextGraphemeCol(line, col);
		if (next >= line.length) {
			col = lastGraphemeCol(line);
			break;
		}
		col = next;
	}
	return { line: state.cursor.line, col };
}

function moveWordForward(state: BufferState, count: number, bigWord = false): Cursor {
	const text = linesToText(state.lines);
	const segments = segmentGraphemes(text);
	if (segments.length === 0) return { line: 0, col: 0 };
	let index = graphemeIndexAtOrAfter(segments, stateOffset(state.lines, state.cursor));
	for (let step = 0; step < count; step++) {
		if (index >= segments.length) return cursorAtLastNormalPosition(state.lines);
		let category = charClass(segments[index]!.segment, bigWord);
		if (category === "space") {
			while (index < segments.length && charClass(segments[index]!.segment, bigWord) === "space") index++;
		} else {
			while (index < segments.length && charClass(segments[index]!.segment, bigWord) === category) index++;
			while (index < segments.length && charClass(segments[index]!.segment, bigWord) === "space") index++;
		}
	}
	if (index >= segments.length) return cursorAtLastNormalPosition(state.lines);
	return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, segments[index]!.index));
}

function moveWordBackward(state: BufferState, count: number, bigWord = false): Cursor {
	const text = linesToText(state.lines);
	const segments = segmentGraphemes(text);
	if (segments.length === 0) return { line: 0, col: 0 };
	let index = graphemeIndexAtOrAfter(segments, stateOffset(state.lines, state.cursor));
	for (let step = 0; step < count; step++) {
		index -= 1;
		while (index >= 0 && charClass(segments[index]!.segment, bigWord) === "space") index--;
		if (index < 0) return normalizeNormalCursor(state.lines, { line: 0, col: 0 });
		const category = charClass(segments[index]!.segment, bigWord);
		while (index > 0 && charClass(segments[index - 1]!.segment, bigWord) === category) index--;
	}
	return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, segments[Math.max(0, index)]!.index));
}

function moveWordEnd(state: BufferState, count: number, bigWord = false): Cursor {
	const text = linesToText(state.lines);
	const segments = segmentGraphemes(text);
	if (segments.length === 0) return { line: 0, col: 0 };
	let index = graphemeIndexAtOrAfter(segments, stateOffset(state.lines, state.cursor));
	for (let step = 0; step < count; step++) {
		if (index >= segments.length) return cursorAtLastNormalPosition(state.lines);
		let category = charClass(segments[index]!.segment, bigWord);
		if (category === "space") {
			while (index < segments.length && charClass(segments[index]!.segment, bigWord) === "space") index++;
			if (index >= segments.length) return cursorAtLastNormalPosition(state.lines);
			category = charClass(segments[index]!.segment, bigWord);
		}
		while (index + 1 < segments.length && charClass(segments[index + 1]!.segment, bigWord) === category) index++;
		if (step < count - 1) index++;
	}
	if (index >= segments.length) return cursorAtLastNormalPosition(state.lines);
	return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, segments[index]!.index));
}

function moveWordEndBackward(state: BufferState, count: number, bigWord = false): Cursor {
	const text = linesToText(state.lines);
	const segments = segmentGraphemes(text);
	if (segments.length === 0) return { line: 0, col: 0 };
	let index = graphemeIndexAtOrAfter(segments, stateOffset(state.lines, state.cursor));
	for (let step = 0; step < count; step++) {
		if (index >= segments.length) index = segments.length - 1;
		else if (charClass(segments[index]!.segment, bigWord) !== "space") {
			const category = charClass(segments[index]!.segment, bigWord);
			while (index > 0 && charClass(segments[index - 1]!.segment, bigWord) === category) index--;
			index--;
		} else {
			index--;
		}
		while (index >= 0 && charClass(segments[index]!.segment, bigWord) === "space") index--;
		if (index < 0) return normalizeNormalCursor(state.lines, { line: 0, col: 0 });
	}
	return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, segments[index]!.index));
}

function matchingBracket(char: string): { open: string; close: string; forward: boolean } | undefined {
	switch (char) {
		case "(":
			return { open: "(", close: ")", forward: true };
		case "[":
			return { open: "[", close: "]", forward: true };
		case "{":
			return { open: "{", close: "}", forward: true };
		case "<":
			return { open: "<", close: ">", forward: true };
		case ")":
			return { open: "(", close: ")", forward: false };
		case "]":
			return { open: "[", close: "]", forward: false };
		case "}":
			return { open: "{", close: "}", forward: false };
		case ">":
			return { open: "<", close: ">", forward: false };
		default:
			return undefined;
	}
}

function findMatchingBracket(state: BufferState): Cursor | null {
	const current = charUnderCursor(state);
	if (!current) return null;
	const match = matchingBracket(current);
	if (!match) return null;
	const text = linesToText(state.lines);
	const start = stateOffset(state.lines, state.cursor);
	let depth = 0;
	if (match.forward) {
		for (let offset = start; offset < text.length; offset++) {
			const char = text[offset];
			if (char === match.open) depth++;
			else if (char === match.close) {
				depth--;
				if (depth === 0) return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, offset));
			}
		}
	} else {
		for (let offset = start; offset >= 0; offset--) {
			const char = text[offset];
			if (char === match.close) depth++;
			else if (char === match.open) {
				depth--;
				if (depth === 0) return normalizeNormalCursor(state.lines, cursorFromOffset(state.lines, offset));
			}
		}
	}
	return null;
}

function charMotion(state: BufferState, key: "f" | "F" | "t" | "T", char: string, count: number): Motion | null {
	const line = currentLine(state);
	if (line.length === 0) return null;
	const currentCharLength = segmentGraphemes(line.slice(state.cursor.col))[0]?.segment.length ?? 1;
	let from = key === "f" || key === "t" ? state.cursor.col + currentCharLength : state.cursor.col - 1;
	let found = -1;
	for (let remaining = count; remaining > 0; remaining--) {
		found = key === "f" || key === "t" ? line.indexOf(char, from) : line.lastIndexOf(char, from);
		if (found < 0) return null;
		from = key === "f" || key === "t" ? found + char.length : found - 1;
	}
	let targetCol = found;
	if (key === "t") targetCol = previousGraphemeCol(line, found);
	if (key === "T") targetCol = nextGraphemeCol(line, found);
	return {
		target: normalizeNormalCursor(state.lines, { line: state.cursor.line, col: targetCol }),
		inclusive: key === "f" || key === "F",
	};
}

function buildCharwiseRange(state: BufferState, from: Cursor, motion: Motion): { start: number; end: number } | null {
	const text = linesToText(state.lines);
	const fromOffset = stateOffset(state.lines, from);
	const targetOffset = stateOffset(state.lines, motion.target);
	if (targetOffset > fromOffset) {
		const end = motion.inclusive ? nextGraphemeOffset(text, targetOffset) : targetOffset;
		return end > fromOffset ? { start: fromOffset, end } : null;
	}
	const end = motion.inclusive ? nextGraphemeOffset(text, fromOffset) : fromOffset;
	return end > targetOffset ? { start: targetOffset, end } : null;
}

function editStateByOffsets(state: BufferState, start: number, end: number, replacement: string, nextCursorOffset: number): BufferState {
	const text = linesToText(state.lines);
	const newText = text.slice(0, start) + replacement + text.slice(end);
	const lines = splitText(newText);
	return { lines, cursor: normalizeInsertCursor(lines, cursorFromOffset(lines, nextCursorOffset)) };
}

function linewiseSelection(state: BufferState, targetLine: number): { startLine: number; endLine: number } {
	return {
		startLine: Math.min(state.cursor.line, targetLine),
		endLine: Math.max(state.cursor.line, targetLine),
	};
}

function isEscapedAt(line: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) backslashes++;
	return backslashes % 2 === 1;
}

function findQuotedSelection(state: BufferState, quote: string, around: boolean): SelectionRange | null {
	const line = currentLine(state);
	const quotePositions: number[] = [];
	for (let index = 0; index < line.length; index++) {
		if (line[index] === quote && !isEscapedAt(line, index)) quotePositions.push(index);
	}
	let bestPair: { open: number; close: number } | null = null;
	for (let index = 0; index + 1 < quotePositions.length; index += 2) {
		const open = quotePositions[index]!;
		const close = quotePositions[index + 1]!;
		if (state.cursor.col < open || state.cursor.col > close) continue;
		if (!bestPair || close - open < bestPair.close - bestPair.open) bestPair = { open, close };
	}
	if (!bestPair) return null;
	const lineStartOffset = stateOffset(state.lines, { line: state.cursor.line, col: 0 });
	return {
		start: lineStartOffset + (around ? bestPair.open : bestPair.open + 1),
		end: lineStartOffset + (around ? bestPair.close + 1 : bestPair.close),
	};
}

function findDelimitedPair(state: BufferState, open: string, close: string): { openOffset: number; closeOffset: number } | null {
	const text = linesToText(state.lines);
	const cursorOffset = stateOffset(state.lines, state.cursor);
	const stack: number[] = [];
	let bestPair: { openOffset: number; closeOffset: number } | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === open) stack.push(index);
		else if (char === close && stack.length > 0) {
			const openOffset = stack.pop()!;
			if (cursorOffset < openOffset || cursorOffset > index) continue;
			if (!bestPair || openOffset > bestPair.openOffset) bestPair = { openOffset, closeOffset: index };
		}
	}
	return bestPair;
}

function findDelimitedSelection(state: BufferState, open: string, close: string, around: boolean): SelectionRange | null {
	const pair = findDelimitedPair(state, open, close);
	if (!pair) return null;
	const text = linesToText(state.lines);
	return {
		start: around ? pair.openOffset : nextGraphemeOffset(text, pair.openOffset),
		end: around ? nextGraphemeOffset(text, pair.closeOffset) : pair.closeOffset,
	};
}

function findWordSelection(state: BufferState, around: boolean, count: number, bigWord = false): SelectionRange | null {
	const text = linesToText(state.lines);
	const segments = segmentGraphemes(text);
	if (segments.length === 0) return null;
	const cursorOffset = stateOffset(state.lines, state.cursor);
	let index = graphemeIndexAtOrAfter(segments, cursorOffset);
	if (index >= segments.length) index = segments.length - 1;
	while (index < segments.length && charClass(segments[index]!.segment, bigWord) === "space") index++;
	if (index >= segments.length) {
		index = Math.max(0, graphemeIndexAtOrAfter(segments, Math.max(0, cursorOffset - 1)));
		while (index > 0 && charClass(segments[index]!.segment, bigWord) === "space") index--;
		if (charClass(segments[index]!.segment, bigWord) === "space") return null;
	}
	const category = charClass(segments[index]!.segment, bigWord);
	let startIndex = index;
	while (startIndex > 0 && charClass(segments[startIndex - 1]!.segment, bigWord) === category) startIndex--;
	let endIndex = index;
	while (endIndex + 1 < segments.length && charClass(segments[endIndex + 1]!.segment, bigWord) === category) endIndex++;
	for (let step = 1; step < count; step++) {
		let nextIndex = endIndex + 1;
		while (nextIndex < segments.length && charClass(segments[nextIndex]!.segment, bigWord) === "space") nextIndex++;
		if (nextIndex >= segments.length) break;
		const nextCategory = charClass(segments[nextIndex]!.segment, bigWord);
		endIndex = nextIndex;
		while (endIndex + 1 < segments.length && charClass(segments[endIndex + 1]!.segment, bigWord) === nextCategory) endIndex++;
	}
	let start = segments[startIndex]!.index;
	let end = endIndex + 1 < segments.length ? segments[endIndex + 1]!.index : text.length;
	if (around) {
		let trailingIndex = endIndex + 1;
		while (trailingIndex < segments.length && charClass(segments[trailingIndex]!.segment, bigWord) === "space") trailingIndex++;
		if (trailingIndex > endIndex + 1) {
			end = trailingIndex < segments.length ? segments[trailingIndex]!.index : text.length;
		} else {
			let leadingIndex = startIndex;
			while (leadingIndex > 0 && charClass(segments[leadingIndex - 1]!.segment, bigWord) === "space") leadingIndex--;
			start = segments[leadingIndex]!.index;
		}
	}
	return { start, end };
}

function resolveTextObjectSelection(state: BufferState, key: string, around: boolean, count: number): SelectionRange | null {
	switch (key) {
		case '"':
		case "'":
		case "`":
			return findQuotedSelection(state, key, around);
		case "(":
		case ")":
			return findDelimitedSelection(state, "(", ")", around);
		case "[":
		case "]":
			return findDelimitedSelection(state, "[", "]", around);
		case "{":
		case "}":
			return findDelimitedSelection(state, "{", "}", around);
		case "<":
		case ">":
			return findDelimitedSelection(state, "<", ">", around);
		case "w":
			return findWordSelection(state, around, count);
		case "W":
			return findWordSelection(state, around, count, true);
		default:
			return null;
	}
}

function deleteLineRange(state: BufferState, startLine: number, endLine: number): BufferState {
	const before = state.lines.slice(0, startLine);
	const after = state.lines.slice(endLine + 1);
	const lines = ensureLines([...before, ...after]);
	const cursorLine = Math.min(startLine, lines.length - 1);
	const cursorCol = firstNonBlankCol(lines[cursorLine] ?? "");
	return { lines, cursor: normalizeNormalCursor(lines, { line: cursorLine, col: cursorCol }) };
}

function changeLineRange(state: BufferState, startLine: number, endLine: number, replacementLine: string): BufferState {
	const before = state.lines.slice(0, startLine);
	const after = state.lines.slice(endLine + 1);
	const lines = ensureLines([...before, replacementLine, ...after]);
	return { lines, cursor: normalizeInsertCursor(lines, { line: startLine, col: replacementLine.length }) };
}

function clampDeleteForwardWithinLine(line: string, startCol: number, count: number): number {
	let col = startCol;
	for (let step = 0; step < count; step++) {
		if (col >= line.length) break;
		col = nextGraphemeCol(line, col);
	}
	return col;
}

function clampDeleteBackwardWithinLine(line: string, startCol: number, count: number): number {
	let col = startCol;
	for (let step = 0; step < count; step++) {
		if (col <= 0) break;
		col = previousGraphemeCol(line, col);
	}
	return col;
}

function stripOneNormalCharRight(line: string, col: number): number {
	return line.length === 0 ? 0 : nextGraphemeCol(line, col);
}

export class MemoryVimBuffer implements VimBuffer {
	private state: BufferState;
	private undoStack: BufferState[] = [];

	constructor(state: BufferState) {
		this.state = cloneState({ lines: ensureLines([...state.lines]), cursor: cloneCursor(state.cursor) });
	}

	getState(): BufferState {
		return cloneState(this.state);
	}

	setCursor(cursor: Cursor): void {
		this.state.cursor = cloneCursor(cursor);
	}

	applyState(state: BufferState): void {
		this.undoStack.push(cloneState(this.state));
		this.state = cloneState({ lines: ensureLines([...state.lines]), cursor: cloneCursor(state.cursor) });
	}

	undo(): void {
		const previous = this.undoStack.pop();
		if (!previous) return;
		this.state = previous;
	}
}

export class VimController {
	private readonly buffer: VimBuffer;
	private mode: VimMode;
	private countBuffer = "";
	private pendingOperator: PendingOperator | null = null;
	private pendingFind: PendingFind | null = null;
	private pendingReplace: PendingReplace | null = null;
	private pendingTextObject: PendingTextObject | null = null;
	private pendingG: { operator?: PendingOperator } | null = null;
	private lastFind: LastFind | null = null;
	private preferredColumn: number | null = null;
	private register: VimRegister = { kind: "char", text: "" };

	constructor(buffer: VimBuffer, options?: { initialMode?: VimMode }) {
		this.buffer = buffer;
		this.mode = options?.initialMode ?? "insert";
	}

	getMode(): VimMode {
		return this.mode;
	}

	isInsertMode(): boolean {
		return this.mode === "insert";
	}

	hasPendingState(): boolean {
		return Boolean(this.countBuffer || this.pendingOperator || this.pendingFind || this.pendingReplace || this.pendingTextObject || this.pendingG);
	}

	clearPendingState(): void {
		this.countBuffer = "";
		this.pendingOperator = null;
		this.pendingFind = null;
		this.pendingReplace = null;
		this.pendingTextObject = null;
		this.pendingG = null;
	}

	getStatusLabel(): string {
		const pieces: string[] = [this.mode === "insert" ? "INSERT" : "NORMAL"];
		if (this.countBuffer) pieces.push(this.countBuffer);
		if (this.pendingOperator) {
			pieces.push(this.pendingOperator.key);
			if (this.pendingOperator.motionCountBuffer) pieces.push(this.pendingOperator.motionCountBuffer);
		}
		if (this.pendingFind) pieces.push(`${this.pendingFind.key}…`);
		if (this.pendingReplace) pieces.push(`r…`);
		if (this.pendingTextObject) pieces.push(`${this.pendingTextObject.kind === "inner" ? "i" : "a"}…`);
		if (this.pendingG) pieces.push("g…");
		return ` ${pieces.join(" ")} `;
	}

	enterNormalModeFromInsert(): void {
		this.mode = "normal";
		this.clearPendingState();
		const state = this.buffer.getState();
		const line = currentLine(state);
		if (line.length === 0 || state.cursor.col === 0) {
			this.buffer.setCursor(normalizeNormalCursor(state.lines, state.cursor));
			return;
		}
		this.buffer.setCursor(normalizeNormalCursor(state.lines, { line: state.cursor.line, col: previousGraphemeCol(line, state.cursor.col) }));
	}

	handleNormalKey(key: string): boolean {
		if (this.mode !== "normal") return false;
		if (key === "escape") {
			if (!this.hasPendingState()) return false;
			this.clearPendingState();
			return true;
		}
		if (this.pendingReplace) return this.handlePendingReplace(key);
		if (this.pendingTextObject) return this.handlePendingTextObject(key);
		if (this.pendingFind) return this.handlePendingFind(key);
		if (this.pendingG) return this.handlePendingG(key);
		if (this.pendingOperator) {
			if (this.maybeAccumulateMotionCount(key)) return true;
			if (key === this.pendingOperator.key) {
				this.applyRepeatedLinewiseOperator(this.pendingOperator, this.consumeMotionCount());
				return true;
			}
			return this.handleOperatorMotionKey(key);
		}
		if (this.maybeAccumulateCount(key)) return true;
		return this.handleStandaloneNormalKey(key);
	}

	private maybeAccumulateCount(key: string): boolean {
		if (!isDigit(key)) return false;
		if (key === "0" && this.countBuffer.length === 0) return false;
		this.countBuffer += key;
		return true;
	}

	private maybeAccumulateMotionCount(key: string): boolean {
		if (!this.pendingOperator || !isDigit(key)) return false;
		if (key === "0" && this.pendingOperator.motionCountBuffer.length === 0) return false;
		this.pendingOperator.motionCountBuffer += key;
		return true;
	}

	private consumeCount(defaultValue = 1): number {
		const count = this.countBuffer.length > 0 ? Number.parseInt(this.countBuffer, 10) : defaultValue;
		this.countBuffer = "";
		return Math.max(1, count || defaultValue);
	}

	private consumeMotionCount(defaultValue = 1): number {
		if (!this.pendingOperator) return defaultValue;
		const count = this.pendingOperator.motionCountBuffer.length > 0
			? Number.parseInt(this.pendingOperator.motionCountBuffer, 10)
			: defaultValue;
		this.pendingOperator.motionCountBuffer = "";
		return Math.max(1, count || defaultValue);
	}

	private resetPreferredColumn(): void {
		this.preferredColumn = null;
	}

	private setNormalCursor(cursor: Cursor, preservePreferredColumn = false): void {
		const state = this.buffer.getState();
		this.buffer.setCursor(normalizeNormalCursor(state.lines, cursor));
		if (!preservePreferredColumn) this.resetPreferredColumn();
	}

	private enterInsertMode(cursor: Cursor): void {
		this.mode = "insert";
		this.clearPendingState();
		this.resetPreferredColumn();
		const state = this.buffer.getState();
		this.buffer.setCursor(normalizeInsertCursor(state.lines, cursor));
	}

	private handleStandaloneNormalKey(key: string): boolean {
		switch (key) {
			case "h":
				this.setNormalCursor(moveLeftWithinLine(this.buffer.getState(), this.consumeCount()));
				return true;
			case "l":
				this.setNormalCursor(moveRightWithinLine(this.buffer.getState(), this.consumeCount()));
				return true;
			case "j":
				this.moveVertical(this.consumeCount());
				return true;
			case "k":
				this.moveVertical(-this.consumeCount());
				return true;
			case "w":
				this.setNormalCursor(moveWordForward(this.buffer.getState(), this.consumeCount()));
				return true;
			case "W":
				this.setNormalCursor(moveWordForward(this.buffer.getState(), this.consumeCount(), true));
				return true;
			case "b":
				this.setNormalCursor(moveWordBackward(this.buffer.getState(), this.consumeCount()));
				return true;
			case "B":
				this.setNormalCursor(moveWordBackward(this.buffer.getState(), this.consumeCount(), true));
				return true;
			case "e":
				this.setNormalCursor(moveWordEnd(this.buffer.getState(), this.consumeCount()));
				return true;
			case "E":
				this.setNormalCursor(moveWordEnd(this.buffer.getState(), this.consumeCount(), true));
				return true;
			case "0": {
				const state = this.buffer.getState();
				this.setNormalCursor({ line: state.cursor.line, col: 0 });
				return true;
			}
			case "^": {
				const state = this.buffer.getState();
				this.setNormalCursor({ line: state.cursor.line, col: firstNonBlankCol(currentLine(state)) });
				return true;
			}
			case "$": {
				const state = this.buffer.getState();
				this.setNormalCursor({ line: state.cursor.line, col: lastGraphemeCol(currentLine(state)) });
				return true;
			}
			case "%": {
				const cursor = findMatchingBracket(this.buffer.getState());
				if (!cursor) return true;
				this.setNormalCursor(cursor);
				return true;
			}
			case "g":
				this.pendingG = {};
				return true;
			case "G":
				this.gotoLine(this.countBuffer.length > 0 ? this.consumeCount() - 1 : Number.MAX_SAFE_INTEGER);
				return true;
			case "f":
			case "F":
			case "t":
			case "T":
				this.pendingFind = { key, count: this.consumeCount() };
				return true;
			case ";":
				this.repeatLastFind(this.consumeCount(), false);
				return true;
			case ",":
				this.repeatLastFind(this.consumeCount(), true);
				return true;
			case "d":
				this.startOperator("delete", "d");
				return true;
			case "c":
				this.startOperator("change", "c");
				return true;
			case "y":
				this.startOperator("yank", "y");
				return true;
			case "x":
				this.deleteCharsUnderCursor(this.consumeCount(), false);
				return true;
			case "X":
				this.deleteCharsBeforeCursor(this.consumeCount());
				return true;
			case "s":
				this.substituteChars(this.consumeCount());
				return true;
			case "S":
				this.changeWholeLines(this.countBuffer.length > 0 ? this.consumeCount() : 1);
				return true;
			case "D":
				this.deleteToLineEnd();
				return true;
			case "C":
				this.changeToLineEnd();
				return true;
			case "Y":
				this.yankWholeLines(this.countBuffer.length > 0 ? this.consumeCount() : 1);
				return true;
			case "p":
				this.putAfter();
				return true;
			case "P":
				this.putBefore();
				return true;
			case "u":
				this.buffer.undo();
				this.mode = "normal";
				this.clearPendingState();
				this.resetPreferredColumn();
				this.setNormalCursor(this.buffer.getState().cursor);
				return true;
			case "i":
				this.enterInsertMode(this.buffer.getState().cursor);
				return true;
			case "a":
				this.appendAfterCursor();
				return true;
			case "I":
				this.insertAtFirstNonBlank();
				return true;
			case "A":
				this.appendAtLineEnd();
				return true;
			case "o":
				this.openLineBelow();
				return true;
			case "O":
				this.openLineAbove();
				return true;
			case "r":
				this.pendingReplace = { count: this.consumeCount() };
				return true;
			case "J":
				this.joinLines(this.countBuffer.length > 0 ? this.consumeCount() : 2);
				return true;
			default:
				this.clearPendingState();
				return false;
		}
	}

	private handlePendingG(key: string): boolean {
		const pending = this.pendingG;
		this.pendingG = null;
		if (pending?.operator) {
			const motion = this.resolvePendingGMotion(key, pending.operator.count);
			if (motion) this.applyOperatorMotion(pending.operator.kind, motion);
			else this.clearPendingState();
			return true;
		}
		switch (key) {
			case "g":
				this.gotoLine(this.countBuffer.length > 0 ? this.consumeCount() - 1 : 0);
				return true;
			case "e":
				this.setNormalCursor(moveWordEndBackward(this.buffer.getState(), this.consumeCount()));
				return true;
			case "E":
				this.setNormalCursor(moveWordEndBackward(this.buffer.getState(), this.consumeCount(), true));
				return true;
			case "_": {
				const state = this.buffer.getState();
				this.setNormalCursor({ line: state.cursor.line, col: lastNonBlankCol(currentLine(state)) });
				return true;
			}
			default:
				this.clearPendingState();
				return true;
		}
	}

	private startOperator(kind: VimOperatorKind, key: PendingOperator["key"]): void {
		this.pendingOperator = { kind, key, count: this.consumeCount(), motionCountBuffer: "" };
	}

	private resolvePendingGMotion(key: string, count: number): Motion | null {
		const state = this.buffer.getState();
		switch (key) {
			case "g": {
				const targetLine = this.countBuffer.length > 0 ? this.consumeCount() - 1 : 0;
				return { target: { line: Math.max(0, Math.min(targetLine, state.lines.length - 1)), col: 0 }, linewise: true };
			}
			case "e":
				return { target: moveWordEndBackward(state, count), inclusive: true };
			case "E":
				return { target: moveWordEndBackward(state, count, true), inclusive: true };
			case "_":
				return { target: { line: state.cursor.line, col: lastNonBlankCol(currentLine(state)) }, inclusive: true };
			default:
				return null;
		}
	}

	private handleOperatorMotionKey(key: string): boolean {
		const operator = this.pendingOperator;
		if (!operator) return false;
		if (key === "f" || key === "F" || key === "t" || key === "T") {
			this.pendingFind = { key, count: this.consumeMotionCount(), operator };
			this.pendingOperator = null;
			return true;
		}
		if (key === "i" || key === "a") {
			this.pendingTextObject = {
				operator,
				kind: key === "i" ? "inner" : "around",
				count: operator.count * this.consumeMotionCount(),
			};
			this.pendingOperator = null;
			return true;
		}
		const motion = this.resolveOperatorMotion(key, operator.count * this.consumeMotionCount(), operator.kind);
		if (!motion) {
			if (this.pendingG) {
				this.pendingOperator = null;
				return true;
			}
			this.pendingOperator = null;
			this.clearPendingState();
			return true;
		}
		this.pendingOperator = null;
		this.applyOperatorMotion(operator.kind, motion);
		return true;
	}

	private resolveOperatorMotion(key: string, count: number, operatorKind: VimOperatorKind): Motion | null {
		const state = this.buffer.getState();
		switch (key) {
			case "h":
				return { target: moveLeftWithinLine(state, count) };
			case "l":
				return { target: moveRightWithinLine(state, count) };
			case "j": {
				const targetLine = Math.min(state.lines.length - 1, state.cursor.line + count);
				return { target: { line: targetLine, col: 0 }, linewise: true };
			}
			case "k": {
				const targetLine = Math.max(0, state.cursor.line - count);
				return { target: { line: targetLine, col: 0 }, linewise: true };
			}
			case "w":
				if (operatorKind === "change" && !/^\s+$/u.test(charUnderCursor(state) ?? "")) {
					return { target: moveWordEnd(state, count), inclusive: true };
				}
				return { target: moveWordForward(state, count) };
			case "W":
				if (operatorKind === "change" && !/^\s+$/u.test(charUnderCursor(state) ?? "")) {
					return { target: moveWordEnd(state, count, true), inclusive: true };
				}
				return { target: moveWordForward(state, count, true) };
			case "b":
				return { target: moveWordBackward(state, count) };
			case "B":
				return { target: moveWordBackward(state, count, true) };
			case "e":
				return { target: moveWordEnd(state, count), inclusive: true };
			case "E":
				return { target: moveWordEnd(state, count, true), inclusive: true };
			case "0":
				return { target: { line: state.cursor.line, col: 0 } };
			case "^":
				return { target: { line: state.cursor.line, col: firstNonBlankCol(currentLine(state)) } };
			case "$":
				return { target: { line: state.cursor.line, col: lastGraphemeCol(currentLine(state)) }, inclusive: true };
			case "%": {
				const target = findMatchingBracket(state);
				return target ? { target, inclusive: true } : null;
			}
			case "g":
				this.pendingG = { operator: { kind: operatorKind, key: operatorKind[0] as PendingOperator["key"], count, motionCountBuffer: "" } };
				return null;
			case "G": {
				const targetLine = this.countBuffer.length > 0 ? this.consumeCount() - 1 : state.lines.length - 1;
				return { target: { line: Math.max(0, Math.min(targetLine, state.lines.length - 1)), col: 0 }, linewise: true };
			}
			default:
				return null;
		}
	}

	private applyRepeatedLinewiseOperator(operator: PendingOperator, motionCount: number): void {
		const count = operator.count * motionCount;
		switch (operator.kind) {
			case "delete":
				this.deleteWholeLines(count);
				break;
			case "change":
				this.changeWholeLines(count);
				break;
			case "yank":
				this.yankWholeLines(count);
				break;
		}
		this.pendingOperator = null;
	}

	private applyOperatorMotion(kind: VimOperatorKind, motion: Motion): void {
		const state = this.buffer.getState();
		if (motion.linewise) {
			const { startLine, endLine } = linewiseSelection(state, motion.target.line);
			const selectedLines = state.lines.slice(startLine, endLine + 1);
			this.register = { kind: "line", lines: [...selectedLines] };
			switch (kind) {
				case "yank":
					return;
				case "delete":
					this.buffer.applyState(deleteLineRange(state, startLine, endLine));
					this.mode = "normal";
					return;
				case "change": {
					const replacementLine = leadingIndent(state.lines[startLine] ?? "");
					this.buffer.applyState(changeLineRange(state, startLine, endLine, replacementLine));
					this.mode = "insert";
					return;
				}
			}
		}
		const range = buildCharwiseRange(state, state.cursor, motion);
		if (!range) return;
		this.applyOperatorSelection(kind, range);
	}

	private applyOperatorSelection(kind: VimOperatorKind, selection: SelectionRange): void {
		const state = this.buffer.getState();
		const text = linesToText(state.lines).slice(selection.start, selection.end);
		this.register = { kind: "char", text };
		if (kind === "yank") return;
		if (selection.start === selection.end) {
			if (kind === "change") this.enterInsertMode(cursorFromOffset(state.lines, selection.start));
			return;
		}
		const nextState = editStateByOffsets(state, selection.start, selection.end, "", selection.start);
		if (kind === "delete") {
			nextState.cursor = normalizeNormalCursor(nextState.lines, nextState.cursor);
			this.buffer.applyState(nextState);
			this.mode = "normal";
			return;
		}
		nextState.cursor = normalizeInsertCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
		this.mode = "insert";
	}

	private handlePendingTextObject(key: string): boolean {
		const pending = this.pendingTextObject;
		this.pendingTextObject = null;
		if (!pending) return true;
		const selection = resolveTextObjectSelection(
			this.buffer.getState(),
			key,
			pending.kind === "around",
			Math.max(1, pending.count),
		);
		if (!selection) return true;
		this.applyOperatorSelection(pending.operator.kind, selection);
		return true;
	}

	private handlePendingFind(key: string): boolean {
		if (key.length === 0) {
			this.pendingFind = null;
			return true;
		}
		const pending = this.pendingFind;
		this.pendingFind = null;
		if (!pending) return true;
		const motion = charMotion(this.buffer.getState(), pending.key, key, pending.count);
		if (!motion) return true;
		this.lastFind = {
			char: key,
			direction: pending.key === "f" || pending.key === "t" ? "forward" : "backward",
			until: pending.key === "t" || pending.key === "T",
		};
		if (pending.operator) {
			this.applyOperatorMotion(pending.operator.kind, motion);
			return true;
		}
		this.setNormalCursor(motion.target);
		return true;
	}

	private handlePendingReplace(key: string): boolean {
		const pending = this.pendingReplace;
		this.pendingReplace = null;
		if (!pending) return true;
		const state = this.buffer.getState();
		const line = currentLine(state);
		if (line.length === 0) return true;
		const endCol = clampDeleteForwardWithinLine(line, state.cursor.col, pending.count);
		if (endCol <= state.cursor.col) return true;
		const startOffset = stateOffset(state.lines, state.cursor);
		const endOffset = stateOffset(state.lines, { line: state.cursor.line, col: endCol });
		const replacement = key.repeat(Math.max(1, pending.count));
		const nextState = editStateByOffsets(state, startOffset, endOffset, replacement, startOffset);
		nextState.cursor = normalizeNormalCursor(nextState.lines, state.cursor);
		this.buffer.applyState(nextState);
		this.mode = "normal";
		return true;
	}

	private repeatLastFind(count: number, reverse: boolean): void {
		if (!this.lastFind) return;
		const key = reverse
			? this.lastFind.direction === "forward"
				? this.lastFind.until
					? "T"
					: "F"
				: this.lastFind.until
					? "t"
					: "f"
			: this.lastFind.direction === "forward"
				? this.lastFind.until
					? "t"
					: "f"
				: this.lastFind.until
					? "T"
					: "F";
		const motion = charMotion(this.buffer.getState(), key, this.lastFind.char, count);
		if (!motion) return;
		this.setNormalCursor(motion.target);
	}

	private gotoLine(targetLine: number): void {
		const state = this.buffer.getState();
		const lineIndex = Math.max(0, Math.min(targetLine, state.lines.length - 1));
		const line = state.lines[lineIndex] ?? "";
		const target = line.length === 0 ? { line: lineIndex, col: 0 } : { line: lineIndex, col: firstNonBlankCol(line) };
		this.setNormalCursor(target);
	}

	private moveVertical(delta: number): void {
		const state = this.buffer.getState();
		const targetLine = Math.max(0, Math.min(state.lines.length - 1, state.cursor.line + delta));
		const goal = this.preferredColumn ?? state.cursor.col;
		const line = state.lines[targetLine] ?? "";
		let targetCol = 0;
		if (line.length > 0) {
			targetCol = goal >= line.length ? lastGraphemeCol(line) : normalizeBoundary(line, goal, false);
		}
		this.preferredColumn = goal;
		this.buffer.setCursor(normalizeNormalCursor(state.lines, { line: targetLine, col: targetCol }));
	}

	private appendAfterCursor(): void {
		const state = this.buffer.getState();
		const line = currentLine(state);
		const col = line.length === 0 ? 0 : stripOneNormalCharRight(line, state.cursor.col);
		this.enterInsertMode({ line: state.cursor.line, col });
	}

	private insertAtFirstNonBlank(): void {
		const state = this.buffer.getState();
		this.enterInsertMode({ line: state.cursor.line, col: firstNonBlankCol(currentLine(state)) });
	}

	private appendAtLineEnd(): void {
		const state = this.buffer.getState();
		this.enterInsertMode({ line: state.cursor.line, col: currentLine(state).length });
	}

	private openLineBelow(): void {
		const state = this.buffer.getState();
		const insertAt = state.cursor.line + 1;
		const indent = leadingIndent(currentLine(state));
		const lines = [...state.lines.slice(0, insertAt), indent, ...state.lines.slice(insertAt)];
		this.buffer.applyState({ lines, cursor: { line: insertAt, col: indent.length } });
		this.mode = "insert";
	}

	private openLineAbove(): void {
		const state = this.buffer.getState();
		const insertAt = state.cursor.line;
		const indent = leadingIndent(currentLine(state));
		const lines = [...state.lines.slice(0, insertAt), indent, ...state.lines.slice(insertAt)];
		this.buffer.applyState({ lines, cursor: { line: insertAt, col: indent.length } });
		this.mode = "insert";
	}

	private deleteCharsUnderCursor(count: number, enterInsert: boolean): void {
		const state = this.buffer.getState();
		const line = currentLine(state);
		if (line.length === 0 || state.cursor.col >= line.length) return;
		const endCol = clampDeleteForwardWithinLine(line, state.cursor.col, count);
		const startOffset = stateOffset(state.lines, state.cursor);
		const endOffset = stateOffset(state.lines, { line: state.cursor.line, col: endCol });
		if (endOffset <= startOffset) return;
		this.register = { kind: "char", text: linesToText(state.lines).slice(startOffset, endOffset) };
		const nextState = editStateByOffsets(state, startOffset, endOffset, "", startOffset);
		nextState.cursor = enterInsert ? normalizeInsertCursor(nextState.lines, nextState.cursor) : normalizeNormalCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
		this.mode = enterInsert ? "insert" : "normal";
	}

	private deleteCharsBeforeCursor(count: number): void {
		const state = this.buffer.getState();
		const line = currentLine(state);
		if (line.length === 0 || state.cursor.col === 0) return;
		const startCol = clampDeleteBackwardWithinLine(line, state.cursor.col, count);
		const startOffset = stateOffset(state.lines, { line: state.cursor.line, col: startCol });
		const endOffset = stateOffset(state.lines, state.cursor);
		this.register = { kind: "char", text: linesToText(state.lines).slice(startOffset, endOffset) };
		const nextState = editStateByOffsets(state, startOffset, endOffset, "", startOffset);
		nextState.cursor = normalizeNormalCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
		this.mode = "normal";
	}

	private substituteChars(count: number): void {
		const state = this.buffer.getState();
		if (currentLine(state).length === 0) {
			this.enterInsertMode(state.cursor);
			return;
		}
		this.deleteCharsUnderCursor(count, true);
	}

	private deleteWholeLines(count: number): void {
		const state = this.buffer.getState();
		const endLine = Math.min(state.lines.length - 1, state.cursor.line + count - 1);
		this.register = { kind: "line", lines: state.lines.slice(state.cursor.line, endLine + 1) };
		this.buffer.applyState(deleteLineRange(state, state.cursor.line, endLine));
		this.mode = "normal";
	}

	private changeWholeLines(count: number): void {
		const state = this.buffer.getState();
		const endLine = Math.min(state.lines.length - 1, state.cursor.line + count - 1);
		this.register = { kind: "line", lines: state.lines.slice(state.cursor.line, endLine + 1) };
		const replacementLine = leadingIndent(currentLine(state));
		this.buffer.applyState(changeLineRange(state, state.cursor.line, endLine, replacementLine));
		this.mode = "insert";
	}

	private yankWholeLines(count: number): void {
		const state = this.buffer.getState();
		const endLine = Math.min(state.lines.length - 1, state.cursor.line + count - 1);
		this.register = { kind: "line", lines: state.lines.slice(state.cursor.line, endLine + 1) };
	}

	private deleteToLineEnd(): void {
		const state = this.buffer.getState();
		const line = currentLine(state);
		if (line.length === 0) return;
		const startOffset = stateOffset(state.lines, state.cursor);
		const endOffset = stateOffset(state.lines, { line: state.cursor.line, col: line.length });
		this.register = { kind: "char", text: linesToText(state.lines).slice(startOffset, endOffset) };
		const nextState = editStateByOffsets(state, startOffset, endOffset, "", startOffset);
		nextState.cursor = normalizeNormalCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
		this.mode = "normal";
	}

	private changeToLineEnd(): void {
		const state = this.buffer.getState();
		const line = currentLine(state);
		const startOffset = stateOffset(state.lines, state.cursor);
		const endOffset = stateOffset(state.lines, { line: state.cursor.line, col: line.length });
		this.register = { kind: "char", text: linesToText(state.lines).slice(startOffset, endOffset) };
		const nextState = editStateByOffsets(state, startOffset, endOffset, "", startOffset);
		nextState.cursor = normalizeInsertCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
		this.mode = "insert";
	}

	private putAfter(): void {
		const state = this.buffer.getState();
		if (this.register.kind === "line") {
			const insertAt = Math.min(state.lines.length, state.cursor.line + 1);
			const lines = [...state.lines.slice(0, insertAt), ...this.register.lines, ...state.lines.slice(insertAt)];
			const cursor = normalizeNormalCursor(lines, { line: insertAt, col: firstNonBlankCol(lines[insertAt] ?? "") });
			this.buffer.applyState({ lines, cursor });
			return;
		}
		const line = currentLine(state);
		const insertCol = line.length === 0 ? 0 : stripOneNormalCharRight(line, state.cursor.col);
		const insertOffset = stateOffset(state.lines, { line: state.cursor.line, col: insertCol });
		const nextState = editStateByOffsets(state, insertOffset, insertOffset, this.register.text, insertOffset + this.register.text.length);
		nextState.cursor = normalizeNormalCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
	}

	private putBefore(): void {
		const state = this.buffer.getState();
		if (this.register.kind === "line") {
			const insertAt = state.cursor.line;
			const lines = [...state.lines.slice(0, insertAt), ...this.register.lines, ...state.lines.slice(insertAt)];
			const cursor = normalizeNormalCursor(lines, { line: insertAt, col: firstNonBlankCol(lines[insertAt] ?? "") });
			this.buffer.applyState({ lines, cursor });
			return;
		}
		const insertOffset = stateOffset(state.lines, state.cursor);
		const nextState = editStateByOffsets(state, insertOffset, insertOffset, this.register.text, insertOffset);
		nextState.cursor = normalizeNormalCursor(nextState.lines, nextState.cursor);
		this.buffer.applyState(nextState);
	}

	private joinLines(totalLines: number): void {
		const state = this.buffer.getState();
		if (state.cursor.line >= state.lines.length - 1) return;
		const endLine = Math.min(state.lines.length - 1, state.cursor.line + Math.max(2, totalLines) - 1);
		const originalCursor = cloneCursor(state.cursor);
		let joined = state.lines[state.cursor.line] ?? "";
		for (let lineIndex = state.cursor.line + 1; lineIndex <= endLine; lineIndex++) {
			const nextLine = (state.lines[lineIndex] ?? "").replace(/^\s+/u, "");
			if (joined.length > 0 && nextLine.length > 0 && !/\s$/u.test(joined)) joined += " ";
			joined += nextLine;
		}
		const lines = [
			...state.lines.slice(0, state.cursor.line),
			joined,
			...state.lines.slice(endLine + 1),
		];
		const cursor = normalizeNormalCursor(lines, { line: originalCursor.line, col: Math.min(originalCursor.col, joined.length) });
		this.buffer.applyState({ lines, cursor });
		this.mode = "normal";
	}
}
