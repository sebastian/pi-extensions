import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Message, TextContent } from "@mariozechner/pi-ai";

export interface SubagentInvocation {
	cwd: string;
	systemPrompt: string;
	prompt: string;
	files?: string[];
	tools?: string[];
	model?: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
	onEvent?: (event: SubagentEvent) => void;
	onUsage?: (usage: SubagentUsageTotals) => void;
}

export interface SubagentEvent {
	type: "tool" | "assistant" | "status";
	message?: string;
	toolName?: string;
	args?: unknown;
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
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function emptySubagentUsageTotals(): SubagentUsageTotals {
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

function addSubagentUsageTotals(total: SubagentUsageTotals, delta: SubagentUsageTotals): SubagentUsageTotals {
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
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	] as string[];

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
	args.push(invocation.prompt);

	const spawned = getPiInvocation(args);

	return await new Promise<SubagentRunResult>((resolvePromise, rejectPromise) => {
		const proc = spawn(spawned.command, spawned.args, {
			cwd: invocation.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderr = "";
		let exitCode = 0;
		let agentMessages: Message[] = [];
		const collectedMessages: Message[] = [];
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let usage = emptySubagentUsageTotals();
		let aborted = false;

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
				case "message_end": {
					const message = event.message;
					if (message && isObject(message)) {
						collectedMessages.push(message as Message);
						if (message.role === "assistant") {
							const assistantMessage = message as Message;
							const assistantText = getAssistantText([assistantMessage]);
							const usageDelta = extractAssistantUsage(assistantMessage);
							usage = addSubagentUsageTotals(usage, usageDelta);
							if (usageDelta.turns) invocation.onUsage?.(usageDelta);
							if (assistantText) invocation.onEvent?.({ type: "assistant", message: assistantText });
							if (typeof message.stopReason === "string") stopReason = message.stopReason;
							if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
						}
					}
					break;
				}
				case "agent_end": {
					if (isMessageArray(event.messages)) {
						agentMessages = event.messages;
						const assistantText = getAssistantText(agentMessages);
						if (assistantText) invocation.onEvent?.({ type: "status", message: assistantText });
					}
					break;
				}
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseEventLine(line);
				if (event) processEvent(event);
			}
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			rejectPromise(error);
		});

		proc.on("close", (code) => {
			exitCode = code ?? 0;
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

		if (invocation.signal) {
			const handleAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5_000);
			};
			if (invocation.signal.aborted) handleAbort();
			else invocation.signal.addEventListener("abort", handleAbort, { once: true });
		}
	});
}
