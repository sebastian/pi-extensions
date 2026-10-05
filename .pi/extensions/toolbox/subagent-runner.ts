import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { type Dirent, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Message, TextContent } from "@earendil-works/pi-ai";

export interface SubagentInvocation {
	cwd: string;
	systemPrompt: string;
	prompt: string;
	files?: string[];
	tools?: string[];
	model?: string;
	thinkingLevel?: string;
	name?: string;
	loadExtensions?: boolean;
	loadSkills?: boolean;
	ipc?: boolean;
	env?: NodeJS.ProcessEnv;
	approveProject?: boolean;
	extensions?: string[];
	signal?: AbortSignal;
	onEvent?: (event: SubagentEvent) => void;
	onUsage?: (usage: SubagentUsageTotals) => void;
}

export interface SubagentEvent {
	type: "tool" | "assistant" | "thinking" | "status";
	message?: string;
	toolName?: string;
	args?: unknown;
	/** Text deltas append; snapshots replace a block (or the whole message without contentIndex). */
	textMode?: "delta" | "snapshot";
	messageId?: number;
	contentIndex?: number;
}

export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

export interface SubagentRunResult {
	exitCode: number;
	stderr: string;
	messages: Message[];
	assistantText: string;
	stopReason?: string;
	errorMessage?: string;
	usage: SubagentUsageTotals;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const EXTENSION_SOURCE_PATTERN = /\.(?:[cm]?[jt]s)$/i;
const EXTENSION_INDEX_FILES = ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function discoverProjectExtensionPaths(repoRoot: string): Promise<string[]> {
	const extensionsRoot = resolve(repoRoot, ".pi", "extensions");
	let entries: Dirent[];
	try {
		entries = await readdir(extensionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const extensionPaths: string[] = [];
	for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name.startsWith(".")) continue;
		const entryPath = resolve(extensionsRoot, entry.name);
		if (entry.isFile()) {
			if (EXTENSION_SOURCE_PATTERN.test(entry.name)) extensionPaths.push(entryPath);
			continue;
		}
		if (!entry.isDirectory()) continue;
		if (await pathExists(resolve(entryPath, "package.json"))) {
			extensionPaths.push(entryPath);
			continue;
		}
		for (const candidate of EXTENSION_INDEX_FILES) {
			const indexPath = resolve(entryPath, candidate);
			if (await pathExists(indexPath)) {
				extensionPaths.push(indexPath);
				break;
			}
		}
	}

	return uniqueStrings(extensionPaths);
}

export function buildSubagentArgs(invocation: SubagentInvocation): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
	] as string[];

	const sessionName = invocation.name?.trim();
	if (sessionName) args.push("--name", sessionName);

	if (invocation.approveProject !== undefined) args.push(invocation.approveProject ? "--approve" : "--no-approve");
	if (!invocation.loadExtensions) args.push("--no-extensions");
	for (const extension of uniqueStrings(invocation.extensions ?? [])) {
		args.push("-e", resolve(extension));
	}

	if (!invocation.loadSkills) args.push("--no-skills");
	args.push("--no-prompt-templates", "--no-themes");

	if (invocation.model) args.push("--model", invocation.model);
	if (invocation.thinkingLevel) args.push("--thinking", invocation.thinkingLevel);
	if (invocation.tools && invocation.tools.length > 0) {
		args.push("--tools", invocation.tools.join(","));
	}
	if (invocation.systemPrompt.trim()) {
		args.push("--append-system-prompt", invocation.systemPrompt.trim());
	}
	for (const file of invocation.files ?? []) {
		args.push(`@${resolve(file)}`);
	}
	args.push("--", invocation.prompt);
	return args;
}

function isMessageArray(value: unknown): value is Message[] {
	return Array.isArray(value);
}

function getAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function parseEventLine(line: string): Record<string, unknown> | null {
	if (!line.trim()) return null;
	try {
		const parsed = JSON.parse(line);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function emptySubagentUsageTotals(): SubagentUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

function extractAssistantUsage(message: Message): SubagentUsageTotals {
	if (message.role !== "assistant") return emptySubagentUsageTotals();
	const usage = (message as Message & { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
	return {
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
		cost: usage?.cost?.total ?? 0,
		turns: 1,
	};
}

export function addSubagentUsageTotals(total: SubagentUsageTotals, delta: SubagentUsageTotals): SubagentUsageTotals {
	return {
		input: total.input + delta.input,
		output: total.output + delta.output,
		cacheRead: total.cacheRead + delta.cacheRead,
		cacheWrite: total.cacheWrite + delta.cacheWrite,
		totalTokens: total.totalTokens + delta.totalTokens,
		cost: total.cost + delta.cost,
		turns: total.turns + delta.turns,
	};
}

export async function runSubagent(invocation: SubagentInvocation): Promise<SubagentRunResult> {
	invocation.signal?.throwIfAborted();
	const args = buildSubagentArgs(invocation);
	const spawned = getPiInvocation(args);

	return await new Promise<SubagentRunResult>((resolvePromise, rejectPromise) => {
		const proc = spawn(spawned.command, spawned.args, {
			cwd: invocation.cwd,
			env: { ...process.env, ...invocation.env },
			shell: false,
			stdio: invocation.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderr = "";
		let exitCode = 0;
		let agentMessages: Message[] = [];
		const collectedMessages: Message[] = [];
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let usage = emptySubagentUsageTotals();
		let messageId = 0;
		let lastTextMessageId = 0;
		let assistantOpen = false;
		const beginAssistant = () => {
			if (!assistantOpen) messageId++;
			assistantOpen = true;
		};
		const snapshot = (message: Record<string, unknown>) => {
			if (!Array.isArray(message.content)) return;
			message.content.forEach((part, contentIndex) => {
				if (isObject(part) && part.type === "text" && typeof part.text === "string") {
					invocation.onEvent?.({ type: "assistant", message: part.text, textMode: "snapshot", messageId, contentIndex });
				}
			});
		};
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const handleAbort = () => {
			aborted = true;
			// Pi's SIGTERM handler aborts tools and cleans up its tracked shell children.
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, 5_000);
		};
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			invocation.signal?.removeEventListener("abort", handleAbort);
		};

		const processEvent = (event: Record<string, unknown>) => {
			switch (event.type) {
				case "tool_execution_start": {
					invocation.onEvent?.({
						type: "tool",
						toolName: typeof event.toolName === "string" ? event.toolName : undefined,
						args: event.args,
					});
					break;
				}
				case "message_start": {
					if (isObject(event.message) && event.message.role === "assistant") beginAssistant();
					break;
				}
				case "message_update": {
					const update = event.assistantMessageEvent;
					if (!isObject(update) || typeof update.type !== "string") break;
					beginAssistant();
					if (update.type.startsWith("thinking_")) {
						// Never forward hidden reasoning, only its activity indicator.
						invocation.onEvent?.({ type: "thinking" });
					} else if (update.type.startsWith("text_")) {
						const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
						if (typeof update.delta === "string") {
							invocation.onEvent?.({ type: "assistant", message: update.delta, textMode: "delta", messageId, contentIndex });
						} else if (isObject(update.partial)) {
							snapshot(update.partial);
						} else if (update.type === "text_end" && typeof update.content === "string") {
							invocation.onEvent?.({ type: "assistant", message: update.content, textMode: "snapshot", messageId, contentIndex });
						}
					}
					break;
				}
				case "message_end": {
					const message = event.message;
					if (message && isObject(message)) {
						collectedMessages.push(message as Message);
						if (message.role === "assistant") {
							beginAssistant();
							const assistantMessage = message as Message;
							const assistantText = getAssistantText([assistantMessage]);
							if (assistantText) lastTextMessageId = messageId;
							const usageDelta = extractAssistantUsage(assistantMessage);
							usage = addSubagentUsageTotals(usage, usageDelta);
							if (usageDelta.turns) invocation.onUsage?.(usageDelta);
							invocation.onEvent?.({ type: "assistant", message: assistantText, textMode: "snapshot", messageId });
							assistantOpen = false;
							if (typeof message.stopReason === "string") stopReason = message.stopReason;
							errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
						}
					}
					break;
				}
				case "agent_end": {
					if (event.willRetry === true) {
						stopReason = undefined;
						errorMessage = undefined;
						break;
					}
					if (isMessageArray(event.messages)) {
						agentMessages = event.messages;
						const assistantText = getAssistantText(agentMessages);
						if (assistantText) invocation.onEvent?.({ type: "status", message: assistantText, textMode: "snapshot", messageId: assistantOpen ? messageId : lastTextMessageId });
					}
					break;
				}
				case "auto_retry_start":
					invocation.onEvent?.({ type: "status", message: `Retry ${event.attempt}: ${event.errorMessage ?? "provider retry"}` });
					break;
			}
		};

		// Decode across pipe chunks so a split UTF-8 character cannot corrupt live feedback.
		proc.stdout!.setEncoding("utf8");
		proc.stderr!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseEventLine(line);
				if (event) processEvent(event);
			}
		});

		proc.stderr!.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			cleanup();
			rejectPromise(error);
		});

		proc.on("close", (code) => {
			cleanup();
			exitCode = code ?? 1;
			if (stdoutBuffer.trim()) {
				const event = parseEventLine(stdoutBuffer);
				if (event) processEvent(event);
			}
			const messages = agentMessages.length > 0 ? agentMessages : collectedMessages;
			if (aborted) {
				rejectPromise(new Error("Subagent execution aborted"));
				return;
			}
			resolvePromise({
				exitCode,
				stderr,
				messages,
				assistantText: getAssistantText(messages),
				stopReason,
				errorMessage,
				usage,
			});
		});

		if (invocation.signal?.aborted) handleAbort();
		else invocation.signal?.addEventListener("abort", handleAbort, { once: true });
	});
}
