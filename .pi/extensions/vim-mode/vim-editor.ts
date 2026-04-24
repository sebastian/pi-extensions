import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AppKeybinding, KeybindingsManager } from "@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import { Key, decodePrintableKey, matchesKey, truncateToWidth, type EditorTheme, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { BufferState, Cursor, VimBuffer } from "./vim-controller.ts";
import { VimController } from "./vim-controller.ts";

interface EditorInternals {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
	historyIndex: number;
	lastAction: string | null;
	onChange?: (text: string) => void;
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	undo(): void;
	cancelAutocomplete(): void;
	getText(): string;
}

const SAFE_APP_SHORTCUTS: AppKeybinding[] = [
	"app.clear",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.followUp",
	"app.message.dequeue",
	"app.clipboard.pasteImage",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
];

function sameCursor(left: Cursor, right: Cursor): boolean {
	return left.line === right.line && left.col === right.col;
}

function sameState(left: BufferState, right: BufferState): boolean {
	if (!sameCursor(left.cursor, right.cursor)) return false;
	if (left.lines.length !== right.lines.length) return false;
	return left.lines.every((line, index) => line === right.lines[index]);
}

class EditorBufferAdapter implements VimBuffer {
	constructor(private readonly editor: VimEditor) {}

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

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.labelTheme = theme;
		this.appKeybindings = keybindings;
		this.controller = new VimController(new EditorBufferAdapter(this), { initialMode: "insert" });
	}

	getInternals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	override handleInput(data: string): void {
		const rerender = (): void => this.tui.requestRender();

		if (matchesKey(data, Key.escape)) {
			if (this.controller.isInsertMode()) {
				this.controller.enterNormalModeFromInsert();
				rerender();
				return;
			}
			if (this.controller.hasPendingState()) {
				this.controller.clearPendingState();
				rerender();
				return;
			}
			super.handleInput(data);
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
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || matchesKey(data, Key.shift("enter"))) {
			return;
		}

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

		const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			this.controller.handleNormalKey(printable);
			rerender();
			return;
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
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
