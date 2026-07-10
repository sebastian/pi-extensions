import test from "node:test";
import assert from "node:assert/strict";
import { getNormalModeInputAction, normalizeParsedNormalModeKey } from "../normal-mode-keys.ts";

test("normal mode submits the configured submit key and ignores configured newline keys", () => {
	const bindings = new Map([
		["enter", "tui.input.submit"],
		["ctrl+j", "tui.input.newLine"],
	]);
	const matches = (data: string, action: string) => bindings.get(data) === action;
	assert.equal(getNormalModeInputAction("enter", matches), "submit");
	assert.equal(getNormalModeInputAction("ctrl+j", matches), "ignore");
	assert.equal(getNormalModeInputAction("x", matches), undefined);
});

test("normalizeParsedNormalModeKey preserves plain keys", () => {
	assert.equal(normalizeParsedNormalModeKey("w"), "w");
	assert.equal(normalizeParsedNormalModeKey("escape"), "escape");
});

test("normalizeParsedNormalModeKey converts shifted letters to uppercase printable keys", () => {
	assert.equal(normalizeParsedNormalModeKey("shift+a"), "A");
	assert.equal(normalizeParsedNormalModeKey("shift+w"), "W");
});

test("normalizeParsedNormalModeKey converts shifted symbol key ids into actual printable symbols", () => {
	assert.equal(normalizeParsedNormalModeKey("shift+9"), "(");
	assert.equal(normalizeParsedNormalModeKey("shift+'"), '"');
	assert.equal(normalizeParsedNormalModeKey("shift+/"), "?");
});

test("normalizeParsedNormalModeKey prefers kitty printable characters when present", () => {
	assert.equal(normalizeParsedNormalModeKey("shift+a", "A"), "A");
	assert.equal(normalizeParsedNormalModeKey("shift+9", "("), "(");
});

test("normalizeParsedNormalModeKey strips alt after insert-escape recovery so fast esc sequences still act like vim", () => {
	assert.equal(normalizeParsedNormalModeKey("alt+c", undefined, { recoveringFromInsertEscape: true }), "c");
	assert.equal(normalizeParsedNormalModeKey("shift+alt+9", undefined, { recoveringFromInsertEscape: true }), "(");
	assert.equal(normalizeParsedNormalModeKey("shift+alt+'", undefined, { recoveringFromInsertEscape: true }), '"');
	assert.equal(normalizeParsedNormalModeKey("alt+c", undefined, { recoveringFromInsertEscape: false }), "alt+c");
});
