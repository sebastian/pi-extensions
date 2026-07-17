import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VimMode } from "./vim-controller.ts";
import { VimEditor } from "./vim-editor.ts";

const REAPPLY_EDITOR_DELAYS_MS = [0, 25, 100, 250] as const;

function isTuiContext(ctx: Pick<ExtensionContext, "hasUI"> & Partial<Pick<ExtensionContext, "mode">>): boolean {
	return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

export default function vimModeExtension(pi: ExtensionAPI): void {
	let activationId = 0;
	let pendingTimers: Array<ReturnType<typeof setTimeout>> = [];

	const emitMode = (mode: VimMode): void => {
		pi.events.emit("vim-mode:mode", { mode });
	};

	const clearPendingTimers = (): void => {
		for (const timer of pendingTimers) clearTimeout(timer);
		pendingTimers = [];
	};

	pi.on("session_start", (_event, ctx) => {
		activationId += 1;
		const sessionActivationId = activationId;
		clearPendingTimers();
		if (!isTuiContext(ctx)) return;

		const applyEditor = (): void => {
			if (sessionActivationId !== activationId) return;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings, {
				onModeChange: emitMode,
				hasPendingMessages: () => ctx.hasPendingMessages(),
			}));
		};

		applyEditor();
		for (const delayMs of REAPPLY_EDITOR_DELAYS_MS) {
			pendingTimers.push(setTimeout(applyEditor, delayMs));
		}
	});

	pi.on("session_shutdown", () => {
		activationId += 1;
		clearPendingTimers();
	});
}
