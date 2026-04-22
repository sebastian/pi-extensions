import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSubagentArgs, discoverProjectExtensionPaths } from "../subagent-runner.ts";

test("buildSubagentArgs disables extension discovery by default", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		systemPrompt: "System",
		prompt: "Review this change",
		tools: ["read", "find"],
	});

	assert.ok(args.includes("--no-extensions"));
	assert.deepEqual(args.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--no-extensions"]);
	assert.ok(!args.includes("-e"));
});

test("buildSubagentArgs can keep normal extensions enabled and add explicit extension sources", () => {
	const args = buildSubagentArgs({
		cwd: "/repo",
		systemPrompt: "System",
		prompt: "Review this change",
		model: "zai-coding-plan/glm-5.1",
		loadExtensions: true,
		extensions: ["/repo/.pi/extensions/zai-coding-plan", "/repo/.pi/extensions/toolbox"],
	});

	assert.ok(!args.includes("--no-extensions"));
	const extensionArgs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-e") extensionArgs.push(args[index + 1] ?? "");
	}
	assert.deepEqual(extensionArgs, [resolve("/repo/.pi/extensions/zai-coding-plan"), resolve("/repo/.pi/extensions/toolbox")]);
	assert.ok(args.includes("--model"));
	assert.ok(args.includes("zai-coding-plan/glm-5.1"));
});

test("discoverProjectExtensionPaths finds package directories and standalone extension files", async () => {
	const root = await mkdtemp(join(tmpdir(), "toolbox-subagent-runner-"));
	try {
		const extensionsRoot = join(root, ".pi", "extensions");
		await mkdir(join(extensionsRoot, "package-extension"), { recursive: true });
		await mkdir(join(extensionsRoot, "index-extension"), { recursive: true });
		await writeFile(join(extensionsRoot, "package-extension", "package.json"), "{}\n", "utf8");
		await writeFile(join(extensionsRoot, "index-extension", "index.ts"), "export default {};\n", "utf8");
		await writeFile(join(extensionsRoot, "standalone.ts"), "export default {};\n", "utf8");
		await writeFile(join(extensionsRoot, "notes.md"), "not an extension\n", "utf8");

		const extensionPaths = await discoverProjectExtensionPaths(root);
		assert.deepEqual(extensionPaths, [
			join(extensionsRoot, "index-extension", "index.ts"),
			join(extensionsRoot, "package-extension"),
			join(extensionsRoot, "standalone.ts"),
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
