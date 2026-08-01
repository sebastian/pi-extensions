import type { BufferState, Cursor, VimBuffer } from "./vim-controller.ts";

export interface OmpEditorHost {
	onChange?: (text: string) => void;
	getLines(): string[];
	getCursor(): Cursor;
	setText(text: string): void;
	moveToMessageStart(): void;
	insertText(text: string): void;
}

interface InsertSession {
	baseline: BufferState;
	mergeWithPreviousEdit: boolean;
}

function cloneState(state: BufferState): BufferState {
	return {
		lines: [...state.lines],
		cursor: { ...state.cursor },
	};
}

function sameText(left: BufferState, right: BufferState): boolean {
	return (
		left.lines.length === right.lines.length &&
		left.lines.every((line, index) => line === right.lines[index])
	);
}

export class OmpEditorBufferAdapter implements VimBuffer {
	private readonly editor: OmpEditorHost;
	private readonly undoStack: BufferState[] = [];
	private insertSession: InsertSession | undefined;
	private revision = 0;

	constructor(editor: OmpEditorHost) {
		this.editor = editor;
	}

	getState(): BufferState {
		return {
			lines: this.editor.getLines(),
			cursor: this.editor.getCursor(),
		};
	}

	getRevision(): number {
		return this.revision;
	}

	setCursor(cursor: Cursor): void {
		const state = this.getState();
		if (state.cursor.line === cursor.line && state.cursor.col === cursor.col)
			return;
		this.writeState({ lines: state.lines, cursor }, false);
	}

	applyState(state: BufferState): void {
		const current = this.getState();
		if (sameText(current, state)) {
			this.setCursor(state.cursor);
			return;
		}
		this.undoStack.push(cloneState(current));
		this.revision += 1;
		this.writeState(state, true);
	}

	beginInsertSession(options?: { mergeWithPreviousEdit?: boolean }): void {
		this.insertSession = {
			baseline: cloneState(this.getState()),
			mergeWithPreviousEdit: options?.mergeWithPreviousEdit ?? false,
		};
	}

	finishInsertSession(): void {
		const session = this.insertSession;
		this.insertSession = undefined;
		if (!session) return;
		const current = this.getState();
		if (sameText(session.baseline, current)) return;
		if (!session.mergeWithPreviousEdit) this.undoStack.push(session.baseline);
		this.revision += 1;
	}

	resetHistory(): void {
		this.undoStack.length = 0;
		this.insertSession = undefined;
	}

	undo(): void {
		const previous = this.undoStack.pop();
		if (!previous) return;
		this.revision += 1;
		this.writeState(previous, true);
	}

	private writeState(state: BufferState, notify: boolean): void {
		const lines = state.lines.length === 0 ? [""] : state.lines;
		const line = Math.max(0, Math.min(state.cursor.line, lines.length - 1));
		const col = Math.max(
			0,
			Math.min(state.cursor.col, lines[line]?.length ?? 0),
		);
		const text = lines.join("\n");
		let offset = col;
		for (let index = 0; index < line; index++)
			offset += (lines[index]?.length ?? 0) + 1;

		const onChange = this.editor.onChange;
		this.editor.onChange = undefined;
		try {
			this.editor.setText(text.slice(offset));
			this.editor.moveToMessageStart();
			if (offset > 0) this.editor.insertText(text.slice(0, offset));
		} finally {
			this.editor.onChange = onChange;
		}
		if (notify) onChange?.(text);
	}
}
