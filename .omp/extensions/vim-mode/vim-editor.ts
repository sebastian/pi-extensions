import {
	CustomEditor,
	type KeybindingsManager,
} from "@oh-my-pi/pi-coding-agent";
import {
	decodePrintableKey,
	type EditorTheme,
	Key,
	matchesKey,
	parseKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
	getNormalModeInputAction,
	normalizeParsedNormalModeKey,
	SAFE_APP_SHORTCUTS,
} from "./normal-mode-keys.ts";
import { OmpEditorBufferAdapter } from "./omp-editor-buffer.ts";
import type { VimMode } from "./vim-controller.ts";
import { VimController } from "./vim-controller.ts";

interface VimEditorOptions {
	onModeChange?: (mode: VimMode) => void;
	hasPendingMessages?: () => boolean;
}

const MODIFIED_KEY_PATTERN = /(?:^|\+)(?:alt|ctrl|super)(?:\+|$)/u;

export class VimEditor extends CustomEditor {
	private readonly labelTheme: EditorTheme;
	private readonly appKeybindings: KeybindingsManager;
	private readonly buffer: OmpEditorBufferAdapter;
	private readonly controller: VimController;
	private readonly onModeChange?: (mode: VimMode) => void;
	private readonly hasPendingMessages?: () => boolean;
	private decorationSearchOffset = 0;
	private lastInsertEscapeAt = 0;
	private readonly insertEscapeRecoveryWindowMs = 180;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options?: VimEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.labelTheme = theme;
		this.appKeybindings = keybindings;
		this.buffer = new OmpEditorBufferAdapter(this);
		this.controller = new VimController(this.buffer, { initialMode: "insert" });
		this.onModeChange = options?.onModeChange;
		this.hasPendingMessages = options?.hasPendingMessages;

		const decorateOmpText = this.decorateText;
		this.decorateText = (text, context) =>
			this.decorateVisualSelection(text, decorateOmpText(text, context));
		this.buffer.beginInsertSession();
		this.onModeChange?.(this.controller.getMode());
	}

	override setTopBorderProvider(
		provider: Parameters<CustomEditor["setTopBorderProvider"]>[0],
	): void {
		super.setTopBorderProvider((availableWidth) => {
			const rawLabel = this.controller.getStatusLabel();
			const labelWidth = Math.min(visibleWidth(rawLabel), availableWidth);
			const label = this.labelTheme.borderColor(
				truncateToWidth(rawLabel, labelWidth, ""),
			);
			const baseWidth = availableWidth - labelWidth;
			const base = provider?.(baseWidth);
			const fill = this.labelTheme.borderColor(
				this.labelTheme.symbols.boxRound.horizontal.repeat(
					Math.max(0, baseWidth - (base?.width ?? 0)),
				),
			);
			return {
				content: `${base?.content ?? ""}${fill}${label}`,
				width: availableWidth,
			};
		});
	}

	override handleInput(data: string): void {
		const previousMode = this.controller.getMode();
		try {
			this.handleInputWithModeTracking(data);
		} finally {
			const nextMode = this.controller.getMode();
			if (nextMode !== previousMode) this.onModeChange?.(nextMode);
		}
	}

	private handleInputWithModeTracking(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.controller.isInsertMode()) {
				this.buffer.finishInsertSession();
				this.controller.enterNormalModeFromInsert();
				this.lastInsertEscapeAt = Date.now();
				this.requestRender();
				return;
			}
			if (this.controller.isVisualMode() || this.controller.hasPendingState()) {
				this.controller.handleNormalKey("escape");
				this.requestRender();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (
			matchesKey(data, Key.up) &&
			this.getText().length === 0 &&
			this.hasPendingMessages?.()
		) {
			this.onDequeue?.();
			this.requestRender();
			return;
		}

		if (this.controller.isInsertMode()) {
			this.delegateInsertInput(data);
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.handleNormalMotion("h");
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.handleNormalMotion("l");
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.handleNormalMotion("k");
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.handleNormalMotion("j");
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.handleNormalMotion("0");
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.handleNormalMotion("$");
			return;
		}

		const inputAction = getNormalModeInputAction(data, (input, action) =>
			this.appKeybindings.matches(input, action),
		);
		if (inputAction === "submit") {
			this.delegateNormalInput(data);
			return;
		}
		if (inputAction === "ignore") return;

		if (this.appKeybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) this.delegateNormalInput(data);
			return;
		}
		for (const action of SAFE_APP_SHORTCUTS) {
			if (this.appKeybindings.matches(data, action)) {
				this.delegateNormalInput(data);
				return;
			}
		}

		if (
			matchesKey(data, Key.tab) ||
			matchesKey(data, Key.backspace) ||
			matchesKey(data, Key.delete)
		)
			return;

		const recoveringFromInsertEscape =
			Date.now() - this.lastInsertEscapeAt <= this.insertEscapeRecoveryWindowMs;
		const parsedKey =
			parseKey(data) ??
			(data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (
			!recoveringFromInsertEscape &&
			parsedKey &&
			MODIFIED_KEY_PATTERN.test(parsedKey)
		) {
			this.delegateNormalInput(data);
			return;
		}

		const key = normalizeParsedNormalModeKey(
			parsedKey,
			decodePrintableKey(data),
			{ recoveringFromInsertEscape },
		);
		this.lastInsertEscapeAt = 0;
		if (key === undefined) return;

		const revision = this.buffer.getRevision();
		this.controller.handleNormalKey(key);
		if (this.controller.isInsertMode()) {
			this.buffer.beginInsertSession({
				mergeWithPreviousEdit: this.buffer.getRevision() !== revision,
			});
		}
		this.requestRender();
	}

	private delegateInsertInput(data: string): void {
		const inputAction = getNormalModeInputAction(data, (input, action) =>
			this.appKeybindings.matches(input, action),
		);
		const endsDraft =
			inputAction === "submit" ||
			this.appKeybindings.matches(data, "app.clear");
		if (!endsDraft) {
			super.handleInput(data);
			return;
		}

		this.buffer.finishInsertSession();
		this.delegateNormalInput(data);
		this.buffer.beginInsertSession();
	}

	private delegateNormalInput(data: string): void {
		const hadDraft = this.getText().length > 0;
		super.handleInput(data);
		if (hadDraft && this.getText().length === 0) this.buffer.resetHistory();
	}

	private handleNormalMotion(key: string): void {
		this.controller.handleNormalKey(key);
		this.requestRender();
	}

	private requestRender(): void {
		this.tui?.requestRender();
	}

	private decorateVisualSelection(text: string, decorated: string): string {
		const selection = this.controller.getVisualSelection();
		if (!selection || text.length === 0) return decorated;

		const source = this.getText();
		const chunkStart = source.indexOf(text, this.decorationSearchOffset);
		if (chunkStart < 0) return decorated;
		this.decorationSearchOffset = chunkStart + text.length;
		const chunkEnd = chunkStart + text.length;
		const start = Math.max(selection.start, chunkStart);
		const end = Math.min(selection.end, chunkEnd);
		if (start >= end) return decorated;

		const startColumn = visibleWidth(text.slice(0, start - chunkStart));
		const endColumn = visibleWidth(text.slice(0, end - chunkStart));
		const before = sliceByColumn(decorated, 0, startColumn);
		const selected = sliceByColumn(
			decorated,
			startColumn,
			endColumn - startColumn,
		).replaceAll("\x1b[0m", "\x1b[0m\x1b[4m");
		const after = sliceByColumn(
			decorated,
			endColumn,
			Math.max(0, visibleWidth(decorated) - endColumn),
		);
		return `${before}\x1b[4m${selected}\x1b[24m${after}`;
	}

	override render(width: number): readonly string[] {
		this.decorationSearchOffset = 0;
		return super.render(width);
	}
}
