import assert from "node:assert/strict";
import test from "node:test";
import {
	OmpEditorBufferAdapter,
	type OmpEditorHost,
} from "../omp-editor-buffer.ts";

class FakeEditorHost implements OmpEditorHost {
	onChange?: (text: string) => void;
	private lines = [""];
	private cursor = { line: 0, col: 0 };

	constructor(text: string, cursor: { line: number; col: number }) {
		this.lines = text.split("\n");
		this.cursor = { ...cursor };
	}

	getLines(): string[] {
		return [...this.lines];
	}

	getCursor(): { line: number; col: number } {
		return { ...this.cursor };
	}

	setText(text: string): void {
		this.lines = text.split("\n");
		const line = this.lines.length - 1;
		this.cursor = { line, col: this.lines[line]?.length ?? 0 };
		this.onChange?.(text);
	}

	moveToMessageStart(): void {
		this.cursor = { line: 0, col: 0 };
	}

	insertText(text: string): void {
		const source = this.lines.join("\n");
		const offset = this.lines
			.slice(0, this.cursor.line)
			.reduce((total, line) => total + line.length + 1, this.cursor.col);
		const next = source.slice(0, offset) + text + source.slice(offset);
		this.lines = next.split("\n");
		const insertedLines = text.split("\n");
		this.cursor =
			insertedLines.length === 1
				? { line: this.cursor.line, col: this.cursor.col + text.length }
				: {
						line: this.cursor.line + insertedLines.length - 1,
						col: insertedLines.at(-1)?.length ?? 0,
					};
		this.onChange?.(next);
	}
}

test("adapter applies text and cursor atomically through OMP's public editor API", () => {
	const editor = new FakeEditorHost("old", { line: 0, col: 2 });
	const changes: string[] = [];
	editor.onChange = (text) => changes.push(text);
	const adapter = new OmpEditorBufferAdapter(editor);

	adapter.applyState({
		lines: ["first", "second"],
		cursor: { line: 1, col: 3 },
	});

	assert.deepEqual(adapter.getState(), {
		lines: ["first", "second"],
		cursor: { line: 1, col: 3 },
	});
	assert.deepEqual(changes, ["first\nsecond"]);
});

test("cursor-only moves do not report text changes", () => {
	const editor = new FakeEditorHost("first\nsecond", { line: 0, col: 1 });
	const changes: string[] = [];
	editor.onChange = (text) => changes.push(text);
	const adapter = new OmpEditorBufferAdapter(editor);

	adapter.setCursor({ line: 1, col: 4 });

	assert.deepEqual(adapter.getState().cursor, { line: 1, col: 4 });
	assert.deepEqual(changes, []);
});

test("insert sessions merge with a preceding Vim change for one-step undo", () => {
	const editor = new FakeEditorHost("before", { line: 0, col: 0 });
	const adapter = new OmpEditorBufferAdapter(editor);

	adapter.applyState({ lines: [""], cursor: { line: 0, col: 0 } });
	adapter.beginInsertSession({ mergeWithPreviousEdit: true });
	editor.setText("after");
	adapter.finishInsertSession();
	adapter.undo();

	assert.deepEqual(adapter.getState(), {
		lines: ["before"],
		cursor: { line: 0, col: 0 },
	});
});

test("resetHistory prevents a submitted draft from being restored by Vim undo", () => {
	const editor = new FakeEditorHost("draft", { line: 0, col: 0 });
	const adapter = new OmpEditorBufferAdapter(editor);

	adapter.applyState({ lines: [""], cursor: { line: 0, col: 0 } });
	adapter.resetHistory();
	adapter.undo();

	assert.deepEqual(adapter.getState(), {
		lines: [""],
		cursor: { line: 0, col: 0 },
	});
});
