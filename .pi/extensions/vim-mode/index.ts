import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VimEditor } from "./vim-editor.ts";

export default function vimModeExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
	});
}
