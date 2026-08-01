import assert from "node:assert/strict";
import test from "node:test";
import {
	getNormalModeInputAction,
	normalizeParsedNormalModeKey,
	SAFE_APP_SHORTCUTS,
} from "../normal-mode-keys.ts";

test("normal mode passes through OMP's clipboard shortcuts", () => {
	assert.ok(SAFE_APP_SHORTCUTS.includes("app.clipboard.copyLine"));
	assert.ok(SAFE_APP_SHORTCUTS.includes("app.clipboard.copyPrompt"));
	assert.ok(
		!(SAFE_APP_SHORTCUTS as readonly string[]).includes("app.message.copy"),
	);
});

test("normal mode submits the configured submit key and ignores configured newline keys", () => {
	const bindings: Record<string, string> = {
		enter: "tui.input.submit",
		"ctrl+j": "tui.input.newLine",
	};
	const matches = (data: string, action: string) => bindings[data] === action;
	assert.equal(getNormalModeInputAction("enter", matches), "submit");
	assert.equal(getNormalModeInputAction("ctrl+j", matches), "ignore");
	assert.equal(getNormalModeInputAction("x", matches), undefined);
});

test("normalizeParsedNormalModeKey converts shifted keys into Vim commands", () => {
	assert.equal(normalizeParsedNormalModeKey("shift+a"), "A");
	assert.equal(normalizeParsedNormalModeKey("shift+9"), "(");
	assert.equal(normalizeParsedNormalModeKey("shift+/"), "?");
});

test("insert-escape recovery strips an alt modifier from coalesced terminal input", () => {
	assert.equal(
		normalizeParsedNormalModeKey("alt+c", undefined, {
			recoveringFromInsertEscape: true,
		}),
		"c",
	);
	assert.equal(
		normalizeParsedNormalModeKey("shift+alt+9", undefined, {
			recoveringFromInsertEscape: true,
		}),
		"(",
	);
	assert.equal(
		normalizeParsedNormalModeKey("alt+c", undefined, {
			recoveringFromInsertEscape: false,
		}),
		"alt+c",
	);
});
