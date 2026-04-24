import test from "node:test";
import assert from "node:assert/strict";
import { MemoryVimBuffer, VimController } from "../vim-controller.ts";

function parseMarkedText(marked: string): { lines: string[]; cursor: { line: number; col: number } } {
	const marker = marked.indexOf("|");
	assert.notEqual(marker, -1, `Missing cursor marker in: ${marked}`);
	const text = marked.slice(0, marker) + marked.slice(marker + 1);
	const lines = text.split("\n");
	let remaining = marker;
	for (let line = 0; line < lines.length; line++) {
		const length = lines[line]!.length;
		if (remaining <= length) return { lines, cursor: { line, col: remaining } };
		remaining -= length + 1;
	}
	return { lines, cursor: { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 } };
}

function renderMarked(buffer: MemoryVimBuffer): string {
	const state = buffer.getState();
	return state.lines
		.map((line, index) => (index === state.cursor.line ? `${line.slice(0, state.cursor.col)}|${line.slice(state.cursor.col)}` : line))
		.join("\n");
}

function createController(marked: string) {
	const state = parseMarkedText(marked);
	const buffer = new MemoryVimBuffer(state);
	const controller = new VimController(buffer, { initialMode: "normal" });
	return { buffer, controller };
}

function feed(controller: VimController, ...keys: string[]): void {
	for (const key of keys) {
		assert.equal(controller.handleNormalKey(key), true, `Key ${key} should be handled`);
	}
}

test("word motions cover w/e/b/ge and line motions cover 0/$/gg/G", () => {
	const { buffer, controller } = createController("|alpha beta\ngamma delta");

	feed(controller, "w");
	assert.equal(renderMarked(buffer), "alpha |beta\ngamma delta");

	feed(controller, "e");
	assert.equal(renderMarked(buffer), "alpha bet|a\ngamma delta");

	feed(controller, "b");
	assert.equal(renderMarked(buffer), "alpha |beta\ngamma delta");

	feed(controller, "g", "e");
	assert.equal(renderMarked(buffer), "alph|a beta\ngamma delta");

	feed(controller, "0");
	assert.equal(renderMarked(buffer), "|alpha beta\ngamma delta");

	feed(controller, "$", "G");
	assert.equal(renderMarked(buffer), "alpha beta\n|gamma delta");

	feed(controller, "g", "g");
	assert.equal(renderMarked(buffer), "|alpha beta\ngamma delta");
});

test("cw changes only the current word and leaves following spacing intact", () => {
	const { buffer, controller } = createController("|hello world");

	feed(controller, "c", "w");

	assert.equal(renderMarked(buffer), "| world");
	assert.equal(controller.getMode(), "insert");
});

test("ci quote and paren text objects delete inside delimiters and enter insert mode", () => {
	const quoteCase = createController('"|hello"');
	feed(quoteCase.controller, "c", "i", '"');
	assert.equal(renderMarked(quoteCase.buffer), '"|"');
	assert.equal(quoteCase.controller.getMode(), "insert");

	const parenCase = createController("(|hello)");
	feed(parenCase.controller, "c", "i", "(");
	assert.equal(renderMarked(parenCase.buffer), "(|)");
	assert.equal(parenCase.controller.getMode(), "insert");
});

test("ciw changes the current word object", () => {
	const { buffer, controller } = createController("|hello world");

	feed(controller, "c", "i", "w");

	assert.equal(renderMarked(buffer), "| world");
	assert.equal(controller.getMode(), "insert");
});

test("cf deletes through the found character and enters insert mode", () => {
	const { buffer, controller } = createController("|hello world");

	feed(controller, "c", "f", "o");

	assert.equal(renderMarked(buffer), "| world");
	assert.equal(controller.getMode(), "insert");
});

test("counts work with operator motions like d2w", () => {
	const { buffer, controller } = createController("|one two three four");

	feed(controller, "d", "2", "w");

	assert.equal(renderMarked(buffer), "|three four");
	assert.equal(controller.getMode(), "normal");
});

test("linewise yy/p and dd behave like vim line operations", () => {
	const yankCase = createController("|one\ntwo\nthree");
	feed(yankCase.controller, "y", "y", "p");
	assert.equal(renderMarked(yankCase.buffer), "one\n|one\ntwo\nthree");

	const deleteCase = createController("|one\ntwo\nthree");
	feed(deleteCase.controller, "2", "d", "d");
	assert.equal(renderMarked(deleteCase.buffer), "|three");
});

test("find motions repeat with ; and ,", () => {
	const { buffer, controller } = createController("|abc abc abc");

	feed(controller, "f", "c");
	assert.equal(renderMarked(buffer), "ab|c abc abc");

	feed(controller, ";");
	assert.equal(renderMarked(buffer), "abc ab|c abc");

	feed(controller, ",");
	assert.equal(renderMarked(buffer), "ab|c abc abc");
});

test("operator-pending g motions work for linewise commands like dgg", () => {
	const { buffer, controller } = createController("one\ntwo\n|three");

	feed(controller, "d", "g", "g");

	assert.equal(renderMarked(buffer), "|");
	assert.equal(controller.getMode(), "normal");
});

test("o preserves indentation and enters insert mode on the new line", () => {
	const { buffer, controller } = createController("    |item");

	feed(controller, "o");

	assert.equal(renderMarked(buffer), "    item\n    |");
	assert.equal(controller.getMode(), "insert");
});

test("r replaces the current character and J joins lines", () => {
	const replaceCase = createController("|abc");
	feed(replaceCase.controller, "r", "x");
	assert.equal(renderMarked(replaceCase.buffer), "|xbc");

	const joinCase = createController("|one\n  two\nthree");
	feed(joinCase.controller, "J");
	assert.equal(renderMarked(joinCase.buffer), "|one two\nthree");
});
