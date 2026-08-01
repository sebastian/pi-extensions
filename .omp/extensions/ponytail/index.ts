import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_MODE = "full" as const;
const COMMAND_DESCRIPTION =
	"Set mode: off|lite|full|ultra. Commands: status, default <mode>";
const SKILL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"skills",
	"ponytail",
	"SKILL.md",
);

export type RuntimeMode = "off" | "lite" | "full" | "ultra";
type PersistedMode = RuntimeMode | "review";

export type PonytailCommand =
	| { type: "status" }
	| { type: "set-mode"; mode: RuntimeMode }
	| { type: "set-default"; mode: RuntimeMode }
	| {
			type: "invalid";
			reason: "invalid-mode" | "invalid-default-mode";
			mode?: string;
	  };

interface PonytailConfig {
	defaultMode?: unknown;
	hideStatus?: unknown;
	quietStartup?: unknown;
}

function normalizeMode(value: unknown): RuntimeMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "off":
		case "lite":
		case "full":
		case "ultra":
			return normalized;
		default:
			return undefined;
	}
}

function normalizePersistedMode(value: unknown): PersistedMode | undefined {
	if (typeof value === "string" && value.trim().toLowerCase() === "review")
		return "review";
	return normalizeMode(value);
}

function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME
		? process.env.XDG_CONFIG_HOME
		: process.platform === "win32"
			? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
			: join(homedir(), ".config");
	return join(base, "ponytail", "config.json");
}

function readConfig(): PonytailConfig {
	try {
		const value: unknown = JSON.parse(
			readFileSync(configPath(), "utf8").replace(/^\uFEFF/, ""),
		);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as PonytailConfig)
			: {};
	} catch {
		return {};
	}
}

function envFlag(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

export function readDefaultMode(): RuntimeMode {
	return (
		normalizeMode(process.env.PONYTAIL_DEFAULT_MODE) ??
		normalizeMode(readConfig().defaultMode) ??
		DEFAULT_MODE
	);
}

export function readHideStatus(): boolean {
	return envFlag("PONYTAIL_HIDE_STATUS") ?? readConfig().hideStatus === true;
}

export function readQuietStartup(): boolean {
	return (
		envFlag("PONYTAIL_QUIET_STARTUP") ?? readConfig().quietStartup === true
	);
}

export function writeDefaultMode(mode: unknown): RuntimeMode | undefined {
	const normalized = normalizeMode(mode);
	if (!normalized) return undefined;
	const path = configPath();
	const config = readConfig();
	config.defaultMode = normalized;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
	return normalized;
}

function isDeactivationCommand(text: unknown): boolean {
	const command = String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/[.!?\s]+$/, "");
	return command === "stop ponytail" || command === "normal mode";
}

export function resolveSessionMode(
	entries: readonly unknown[],
	fallbackMode: PersistedMode = DEFAULT_MODE,
): PersistedMode {
	const fallback = normalizePersistedMode(fallbackMode) ?? DEFAULT_MODE;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			customType?: unknown;
			data?: { mode?: unknown };
		};
		if (candidate.type !== "custom" || candidate.customType !== "ponytail-mode")
			continue;
		const mode = normalizePersistedMode(candidate.data?.mode);
		if (mode) return mode;
	}
	return fallback;
}

export function parsePonytailCommand(
	text: unknown,
	defaultMode: PersistedMode = DEFAULT_MODE,
): PonytailCommand {
	const fallback = normalizePersistedMode(defaultMode) ?? DEFAULT_MODE;
	const normalized = String(text ?? "")
		.trim()
		.toLowerCase();
	if (!normalized)
		return {
			type: "set-mode",
			mode: fallback === "off" || fallback === "review" ? "full" : fallback,
		};

	const [primary, secondary] = normalized.split(/\s+/, 2);
	if (primary === "status") return { type: "status" };
	if (primary === "default") {
		const mode = normalizeMode(secondary);
		return mode
			? { type: "set-default", mode }
			: { type: "invalid", reason: "invalid-default-mode" };
	}
	const mode = normalizeMode(primary);
	return mode
		? { type: "set-mode", mode }
		: { type: "invalid", reason: "invalid-mode", mode: primary };
}

export function filterSkillBodyForMode(
	body: string,
	mode: RuntimeMode,
): string {
	return body
		.replace(/^---[\s\S]*?---\s*/, "")
		.split(/\r?\n/)
		.filter((line) => {
			const tableMode = normalizeMode(
				line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/)?.[1],
			);
			if (tableMode) return tableMode === mode;
			const exampleMode = normalizeMode(line.match(/^-\s*([^:]+):\s*"/)?.[1]);
			return !exampleMode || exampleMode === mode;
		})
		.join("\n");
}

function fallbackInstructions(mode: RuntimeMode): string {
	return `PONYTAIL MODE ACTIVE — level: ${mode}\n\nYou are a lazy senior developer. Lazy means efficient, not careless. Before writing code: understand the real flow, reuse existing code, prefer the standard library and native platform, avoid new dependencies, then write the minimum that works. Never remove trust-boundary validation, data-loss prevention, security, accessibility, or anything explicitly required.`;
}

function loadInstructions(mode: RuntimeMode): string {
	try {
		return `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${filterSkillBodyForMode(readFileSync(SKILL_PATH, "utf8"), mode)}`;
	} catch {
		return fallbackInstructions(mode);
	}
}

const INSTRUCTIONS: Record<Exclude<RuntimeMode, "off">, string> = {
	lite: loadInstructions("lite"),
	full: loadInstructions("full"),
	ultra: loadInstructions("ultra"),
};

function instructionsFor(mode: PersistedMode): string | undefined {
	if (mode === "off") return undefined;
	if (mode === "review")
		return "PONYTAIL MODE ACTIVE — level: review. Behavior defined by the ponytail-review skill.";
	return INSTRUCTIONS[mode];
}

export default function ponytailExtension(omp: ExtensionAPI): void {
	let currentMode: PersistedMode = DEFAULT_MODE;
	let configuredDefaultMode = readDefaultMode();
	let hideStatus = readHideStatus();
	let active = false;
	let lastContext: ExtensionContext | undefined;

	const syncStatus = (context?: ExtensionContext): void => {
		if (context) lastContext = context;
		const target = context ?? lastContext;
		if (hideStatus || !target?.hasUI) return;
		target.ui.setStatus(
			"ponytail",
			currentMode === "off"
				? ""
				: `ponytail: ${currentMode} (${active ? "active" : "idle"})`,
		);
	};

	const setMode = (mode: unknown, context?: ExtensionContext): void => {
		const normalized = normalizePersistedMode(mode);
		if (!normalized) return;
		currentMode = normalized;
		omp.appendEntry("ponytail-mode", { mode: normalized });
		syncStatus(context);
		context?.ui.notify(`Ponytail mode set to ${normalized}.`, "info");
	};

	const sendSkill = (skill: string, context: ExtensionContext): void => {
		const message = `/skill:${skill}`;
		if (!context.isIdle()) {
			omp.sendUserMessage(message, { deliverAs: "followUp" });
			context.ui.notify(`${skill} queued as follow-up.`, "info");
			return;
		}
		omp.sendUserMessage(message);
	};

	omp.registerCommand("ponytail", {
		description: COMMAND_DESCRIPTION,
		handler: async (args, context) => {
			const command = parsePonytailCommand(args, configuredDefaultMode);
			switch (command.type) {
				case "status":
					context.ui.notify(
						`Ponytail: current ${currentMode}; default ${configuredDefaultMode}.`,
						"info",
					);
					return;
				case "set-default": {
					try {
						const written = writeDefaultMode(command.mode);
						if (!written) return;
						configuredDefaultMode = readDefaultMode();
						const message =
							configuredDefaultMode === written
								? `Default Ponytail mode set to ${written}.`
								: `Saved default ${written}, but the environment keeps the default at ${configuredDefaultMode}.`;
						context.ui.notify(message, "info");
					} catch (error) {
						context.ui.notify(
							`Failed to save default mode: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					return;
				}
				case "set-mode":
					setMode(command.mode, context);
					return;
				case "invalid":
					context.ui.notify(
						"Unknown or unsupported /ponytail mode.",
						"warning",
					);
			}
		},
	});

	for (const skill of [
		"ponytail-review",
		"ponytail-audit",
		"ponytail-gain",
		"ponytail-debt",
		"ponytail-help",
	] as const) {
		omp.registerCommand(skill, {
			description: `Run /skill:${skill}`,
			handler: async (_args, context) => sendSkill(skill, context),
		});
	}

	omp.on("input", async (event, context) => {
		if (
			event.source === "extension" ||
			currentMode === "off" ||
			!isDeactivationCommand(event.text)
		)
			return;
		setMode("off", context);
	});

	omp.on("session_start", async (_event, context) => {
		configuredDefaultMode = readDefaultMode();
		hideStatus = readHideStatus();
		currentMode = resolveSessionMode(
			context.sessionManager.getBranch(),
			configuredDefaultMode,
		);
		syncStatus(context);
		if (!readQuietStartup())
			context.ui.notify(`Ponytail loaded: ${currentMode}.`, "info");
	});

	omp.on("agent_start", async (_event, context) => {
		active = true;
		syncStatus(context);
	});

	omp.on("agent_end", async (_event, context) => {
		active = false;
		syncStatus(context);
	});

	omp.on("before_agent_start", async (event) => {
		const instructions = instructionsFor(currentMode);
		if (!instructions) return undefined;
		const base =
			typeof event?.systemPrompt === "string" && event.systemPrompt
				? `${event.systemPrompt}\n\n`
				: "";
		return { systemPrompt: `${base}${instructions}` };
	});
}
