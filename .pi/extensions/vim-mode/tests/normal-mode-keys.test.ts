import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParsedNormalModeKey } from "../normal-mode-keys.ts";

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
