import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectSuggestedCheckCommands,
	discoverRelevantChecks,
	extractSuggestedCheckCommands,
	getCheckCommandSafety,
} from "../checks.ts";

test("discoverRelevantChecks walks ancestors up to repo root", async () => {
	const root = await mkdtemp(join(tmpdir(), "guided-discovery-checks-"));
	await mkdir(join(root, ".jj"));
	await mkdir(join(root, "src", "feature"), { recursive: true });
	await writeFile(join(root, "CHECKS.md"), "```bash\nnpm test\n```\n", "utf8");
	await writeFile(join(root, "src", "CHECKS.md"), "```bash\npnpm run lint\n```\n", "utf8");

	const result = discoverRelevantChecks(root, ["src/feature/index.ts"]);
	assert.equal(result.documents.length, 2);
	assert.deepEqual(result.fileToChecks["src/feature/index.ts"], ["src/CHECKS.md", "CHECKS.md"]);
});

test("extractSuggestedCheckCommands reads fenced blocks and inline commands", () => {
	const markdown = [
		"Run `npm test` before shipping.",
		"",
		"```bash",
		"# lint",
		"pnpm run lint",
		"$ cargo test",
		"```",
	].join("\n");

	assert.deepEqual(extractSuggestedCheckCommands(markdown), ["pnpm run lint", "cargo test", "npm test"]);
});

test("collectSuggestedCheckCommands marks unsafe commands as blocked", () => {
	const commands = collectSuggestedCheckCommands([
		{
			path: "/repo/CHECKS.md",
			relativePath: "CHECKS.md",
			content: "```bash\nnpm test\nrm -rf build\n```",
			appliesTo: ["src/index.ts"],
		},
	]);

	assert.equal(commands.length, 2);
	assert.equal(commands[0].safe, true);
	assert.equal(commands[1].safe, false);
	assert.match(commands[1].reason ?? "", /Blocked/);
});

test("getCheckCommandSafety allows common verification commands and blocks destructive ones", () => {
	assert.deepEqual(getCheckCommandSafety("npm test"), { safe: true });
	assert.deepEqual(getCheckCommandSafety("pnpm run lint"), { safe: true });
	assert.equal(getCheckCommandSafety("rm -rf node_modules").safe, false);
	assert.equal(getCheckCommandSafety("npm install").safe, false);
});
