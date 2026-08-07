import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	Key,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { VimEditor } from "../vim-editor.ts";

const box = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
};

const theme = {
	borderColor: (text: string) => text,
	selectList: {},
	symbols: {
		cursor: "▏",
		inputCursor: "▏",
		boxRound: box,
		boxSharp: box,
		table: box,
		quoteBorder: "│",
		hrChar: "─",
		spinnerFrames: ["-"],
	},
} as unknown as EditorTheme;

function createEditor(): VimEditor {
	const editor = new VimEditor({} as TUI, theme, {
		matches: () => false,
	} as unknown as KeybindingsManager);
	editor.focused = true;
	editor.setTopBorderProvider((width) => ({
		content: "status".slice(0, width),
		width: Math.min(6, width),
	}));
	return editor;
}

function assertEndVisible(editor: VimEditor): void {
	const rendered = editor.render(20);
	assert.ok(rendered.some((line) => line.includes("jklm")));
	assert.ok(rendered.some((line) => line.includes(CURSOR_MARKER)));
	const rowWidths = rendered.map((line) =>
		visibleWidth(line.replaceAll(CURSOR_MARKER, "")),
	);
	assert.ok(rowWidths.every((width) => width <= 20), JSON.stringify(rowWidths));
}

test("mode label keeps the end of input visible in insert and normal modes", () => {
	const editor = createEditor();
	editor.setText("abcdefghijklm");
	assertEndVisible(editor);

	editor.handleInput(Key.escape);
	assertEndVisible(editor);
});
