import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, parseKey, sliceByColumn, truncateToWidth, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { getNormalModeInputAction, normalizeParsedNormalModeKey, SAFE_APP_SHORTCUTS } from "./normal-mode-keys.ts";
import type { BufferState, Cursor, VimBuffer, VimMode } from "./vim-controller.ts";
import { VimController } from "./vim-controller.ts";

interface EditorInternals {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
	historyIndex: number;
	lastAction: string | null;
	lastWidth: number;
	scrollOffset: number;
	paddingX: number;
	onChange?: (text: string) => void;
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	undo(): void;
	cancelAutocomplete(): void;
	getText(): string;
	buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
}

interface VimEditorOptions {
	onModeChange?: (mode: VimMode) => void;
	hasPendingMessages?: () => boolean;
}

function sameCursor(left: Cursor, right: Cursor): boolean {
	return left.line === right.line && left.col === right.col;
}

function sameState(left: BufferState, right: BufferState): boolean {
	if (!sameCursor(left.cursor, right.cursor)) return false;
	if (left.lines.length !== right.lines.length) return false;
	return left.lines.every((line, index) => line === right.lines[index]);
}

class EditorBufferAdapter implements VimBuffer {
	private readonly editor: VimEditor;

	constructor(editor: VimEditor) {
		this.editor = editor;
	}

	getState(): BufferState {
		const internals = this.editor.getInternals();
		return {
			lines: [...internals.state.lines],
			cursor: {
				line: internals.state.cursorLine,
				col: internals.state.cursorCol,
			},
		};
	}

	setCursor(cursor: Cursor): void {
		const internals = this.editor.getInternals();
		internals.historyIndex = -1;
		internals.lastAction = null;
		internals.state.cursorLine = cursor.line;
		internals.setCursorCol(cursor.col);
	}

	applyState(state: BufferState): void {
		const internals = this.editor.getInternals();
		const current = this.getState();
		if (sameState(current, state)) return;
		internals.cancelAutocomplete();
		internals.pushUndoSnapshot();
		internals.historyIndex = -1;
		internals.lastAction = null;
		internals.state.lines = state.lines.length === 0 ? [""] : [...state.lines];
		internals.state.cursorLine = Math.max(0, Math.min(state.cursor.line, internals.state.lines.length - 1));
		internals.setCursorCol(state.cursor.col);
		internals.onChange?.(internals.getText());
	}

	undo(): void {
		this.editor.getInternals().undo();
	}
}

export class VimEditor extends CustomEditor {
	private readonly labelTheme: EditorTheme;
	private readonly appKeybindings: KeybindingsManager;
	private readonly controller: VimController;
	private readonly onModeChange?: (mode: VimMode) => void;
	private readonly hasPendingMessages?: () => boolean;
	private lastInsertEscapeAt = 0;
	private readonly insertEscapeRecoveryWindowMs = 180;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: VimEditorOptions) {
		super(tui, theme, keybindings);
		this.labelTheme = theme;
		this.appKeybindings = keybindings;
		this.controller = new VimController(new EditorBufferAdapter(this), { initialMode: "insert" });
		this.onModeChange = options?.onModeChange;
		this.hasPendingMessages = options?.hasPendingMessages;
		this.onModeChange?.(this.controller.getMode());
	}

	getInternals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	override handleInput(data: string): void {
		const previousMode = this.controller.getMode();
		try {
			this.handleInputWithModeTracking(data);
		} finally {
			const nextMode = this.controller.getMode();
			if (nextMode !== previousMode) this.onModeChange?.(nextMode);
		}
	}

	private handleInputWithModeTracking(data: string): void {
		const rerender = (): void => this.tui.requestRender();

		if (matchesKey(data, Key.escape)) {
			if (this.controller.isInsertMode()) {
				this.controller.enterNormalModeFromInsert();
				this.lastInsertEscapeAt = Date.now();
				rerender();
				return;
			}
			if (this.controller.isVisualMode() || this.controller.hasPendingState()) {
				this.controller.handleNormalKey("escape");
				rerender();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, Key.up) && this.getText().length === 0 && this.hasPendingMessages?.()) {
			this.actionHandlers.get("app.message.dequeue")?.();
			rerender();
			return;
		}

		if (this.controller.isInsertMode()) {
			super.handleInput(data);
			return;
		}

		if (this.onExtensionShortcut?.(data)) return;

		if (matchesKey(data, Key.left)) {
			this.controller.handleNormalKey("h");
			rerender();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.controller.handleNormalKey("l");
			rerender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.controller.handleNormalKey("k");
			rerender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.controller.handleNormalKey("j");
			rerender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.controller.handleNormalKey("0");
			rerender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.controller.handleNormalKey("$");
			rerender();
			return;
		}
		const inputAction = getNormalModeInputAction(data, (input, action) => this.appKeybindings.matches(input, action));
		if (inputAction === "submit") {
			super.handleInput(data);
			return;
		}
		if (inputAction === "ignore") return;

		if (this.appKeybindings.matches(data, "app.exit") && this.getText().length === 0) {
			super.handleInput(data);
			return;
		}
		for (const action of SAFE_APP_SHORTCUTS) {
			if (this.appKeybindings.matches(data, action)) {
				super.handleInput(data);
				return;
			}
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			return;
		}

		const recoveringFromInsertEscape = Date.now() - this.lastInsertEscapeAt <= this.insertEscapeRecoveryWindowMs;
		const key = normalizeParsedNormalModeKey(
			parseKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined),
			decodeKittyPrintable(data),
			{ recoveringFromInsertEscape },
		);
		this.lastInsertEscapeAt = 0;
		if (key !== undefined) {
			this.controller.handleNormalKey(key);
			rerender();
			return;
		}
	}

	private highlightVisualSelection(rendered: string[], width: number): void {
		const selection = this.controller.getVisualSelection();
		if (!selection) return;
		// ponytail: pi has no selection renderer; drop this internal layout mapping when it exposes one.
		const internals = this.getInternals();
		const visualLines = internals.buildVisualLineMap(internals.lastWidth);
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		const visibleLines = visualLines.slice(internals.scrollOffset, internals.scrollOffset + maxVisibleLines);
		const paddingX = Math.min(internals.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const lineOffsets: number[] = [];
		let offset = 0;
		for (const line of internals.state.lines) {
			lineOffsets.push(offset);
			offset += line.length + 1;
		}

		for (let index = 0; index < visibleLines.length; index++) {
			const visualLine = visibleLines[index]!;
			const source = internals.state.lines[visualLine.logicalLine] ?? "";
			const chunkStart = (lineOffsets[visualLine.logicalLine] ?? 0) + visualLine.startCol;
			const start = Math.max(selection.start, chunkStart);
			const end = Math.min(selection.end, chunkStart + visualLine.length);
			if (start >= end) continue;
			const chunk = source.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
			const startColumn = paddingX + visibleWidth(chunk.slice(0, start - chunkStart));
			const endColumn = paddingX + visibleWidth(chunk.slice(0, end - chunkStart));
			const line = rendered[index + 1];
			if (!line) continue;
			const before = sliceByColumn(line, 0, startColumn);
			const selected = sliceByColumn(line, startColumn, endColumn - startColumn).replaceAll("\x1b[0m", "\x1b[0m\x1b[4m");
			const after = sliceByColumn(line, endColumn, Math.max(0, visibleWidth(line) - endColumn));
			rendered[index + 1] = `${before}\x1b[4m${selected}\x1b[24m${after}`;
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		this.highlightVisualSelection(lines, width);
		const label = this.labelTheme.borderColor(this.controller.getStatusLabel());
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= visibleWidth(label)) {
			lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - visibleWidth(label)), "") + label;
		} else {
			lines[last] = truncateToWidth(label, width, "");
		}
		return lines;
	}
}
