import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { VimMode } from "./vim-controller.ts";
import { VimEditor } from "./vim-editor.ts";

const REAPPLY_EDITOR_DELAYS_MS = [25, 100, 250] as const;

export default function vimModeExtension(omp: ExtensionAPI): void {
	let activationId = 0;
	let pendingTimers: Array<{ context: ExtensionContext; timer: Timer }> = [];

	const emitMode = (mode: VimMode): void => {
		omp.events.emit("vim-mode:mode", { mode });
	};

	const clearPendingTimers = (): void => {
		for (const { context, timer } of pendingTimers) context.clearTimer(timer);
		pendingTimers = [];
	};

	omp.on("session_start", (_event, ctx) => {
		activationId += 1;
		const sessionActivationId = activationId;
		clearPendingTimers();
		if (!ctx.hasUI) return;

		const applyEditor = (): void => {
			if (sessionActivationId !== activationId) return;
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) =>
					new VimEditor(tui, theme, keybindings, {
						onModeChange: emitMode,
						hasPendingMessages: () => ctx.hasPendingMessages(),
					}),
			);
		};

		applyEditor();
		for (const delayMs of REAPPLY_EDITOR_DELAYS_MS) {
			pendingTimers.push({
				context: ctx,
				timer: ctx.setTimeout(applyEditor, delayMs),
			});
		}
	});

	omp.on("session_shutdown", () => {
		activationId += 1;
		clearPendingTimers();
	});
}
