import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VimEditor } from "./vim-editor.ts";

const REAPPLY_EDITOR_DELAYS_MS = [0, 25, 100, 250] as const;

export default function vimModeExtension(pi: ExtensionAPI): void {
	let activationId = 0;
	let pendingTimers: Array<ReturnType<typeof setTimeout>> = [];

	const clearPendingTimers = (): void => {
		for (const timer of pendingTimers) clearTimeout(timer);
		pendingTimers = [];
	};

	pi.on("session_start", (_event, ctx) => {
		activationId += 1;
		const sessionActivationId = activationId;
		clearPendingTimers();

		const applyEditor = (): void => {
			if (sessionActivationId !== activationId) return;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
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
