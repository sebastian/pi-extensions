import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import vimModeExtension from "../index.ts";
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

function createEditor(
	onModeChange?: (mode: string) => void,
	onStatusChange?: (status: string) => void,
): VimEditor {
	const editor = new VimEditor(
		{} as TUI,
		theme,
		{
			matches: () => false,
		} as unknown as KeybindingsManager,
		{ onModeChange, onStatusChange },
	);
	editor.focused = true;
	editor.setTopBorderProvider((width) => ({
		content: "status".slice(0, width),
		width: Math.min(6, width),
	}));
	return editor;
}

function assertEndVisible(editor: VimEditor): void {
	const rendered = editor.render(20);
	assert.ok(rendered.some((line) => line.includes("jkl")));
	assert.ok(rendered.some((line) => line.includes(CURSOR_MARKER)));
	const rowWidths = rendered.map((line) =>
		visibleWidth(line.replaceAll(CURSOR_MARKER, "")),
	);
	assert.ok(rowWidths.every((width) => width <= 20), JSON.stringify(rowWidths));
}

test("input stays visible across OMP 18 composer shapes", () => {
	for (const style of ["box", "band", "rule", "borderless"] as const) {
		const modes: string[] = [];
		const editor = createEditor((mode) => modes.push(mode));
		editor.setBorderStyle(style);
		editor.setText("abcdefghijklm");
		assertEndVisible(editor);

		editor.handleInput("\x1b");
		assertEndVisible(editor);
		assert.deepEqual(modes, ["insert", "normal"], style);
	}
});

test("visual decoration uses context for repeated out-of-order chunks", () => {
	const editor = createEditor();
	editor.setText("same same");
	editor.handleInput("\x1b");
	editor.handleInput("0");
	for (let index = 0; index < 5; index++) editor.handleInput("l");
	editor.handleInput("v");
	for (let index = 0; index < 3; index++) editor.handleInput("l");

	assert.match(
		editor.decorateText?.("same", { line: 0, startCol: 5, endCol: 9 }) ?? "",
		/\x1b\[4m/u,
	);
	assert.doesNotMatch(
		editor.decorateText?.("same", { line: 0, startCol: 0, endCol: 4 }) ?? "",
		/\x1b\[4m/u,
	);
});

test("keeps OMP's built-in modal layer disabled", () => {
	const statuses: string[] = [];
	const editor = createEditor(undefined, (status) => statuses.push(status));
	editor.setVimMode(true);
	assert.equal(editor.vimEnabled, false);
	editor.handleInput("\x1b");
	assert.equal(statuses.at(-1), "NORMAL");
});

test("publishes mode through the native OMP status surface", () => {
	const handlers = new Map<string, (event: unknown, context: never) => void>();
	const statuses: Array<string | undefined> = [];
	let editor: VimEditor | undefined;
	vimModeExtension({
		on: (name: string, handler: (event: unknown, context: never) => void) =>
			handlers.set(name, handler),
		events: { emit: () => {} },
	} as never);
	const context = {
		hasUI: true,
		hasPendingMessages: () => false,
		setTimeout: () => 0,
		clearTimer: () => {},
		ui: {
			setStatus: (_key: string, text: string | undefined) =>
				statuses.push(text),
			setEditorComponent: (
				factory: (
					tui: TUI,
					editorTheme: EditorTheme,
					keybindings: KeybindingsManager,
				) => VimEditor,
			) => {
				editor = factory(
					{} as TUI,
					theme,
					{ matches: () => false } as unknown as KeybindingsManager,
				);
			},
		},
	};

	handlers.get("session_start")?.({}, context as never);
	assert.equal(statuses.at(-1), "vim: INSERT");
	editor?.handleInput("\x1b");
	assert.equal(statuses.at(-1), "vim: NORMAL");
	editor?.handleInput("2");
	editor?.handleInput("d");
	assert.equal(statuses.at(-1), "vim: NORMAL 2 d");
});
