import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { ValidationDiscrepancy } from "./structured-output.ts";

export interface DiscrepancySelectorOptions {
	title: string;
	actionableDiscrepancies: ValidationDiscrepancy[];
	informationalDiscrepancies?: ValidationDiscrepancy[];
	introLines?: string[];
}

interface DiscrepancySelectorSubmitResult {
	kind: "submit";
	selectedIds: string[];
}

interface DiscrepancySelectorCancelResult {
	kind: "cancel";
}

const CHECKED_BACKTICK_ID_PATTERN = /^\s*(?:[-*+]\s+|\d+\.\s+)\[(?:x|X)\]\s+`([^`]+)`/;
const CHECKED_PLAIN_ID_PATTERN = /^\s*(?:[-*+]\s+|\d+\.\s+)\[(?:x|X)\]\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b/;

function trimBlock(text: string): string {
	return text.trim() ? `${text.trim()}\n` : "";
}

function isActionableDiscrepancy(discrepancy: ValidationDiscrepancy): boolean {
	return discrepancy.status === "missing" || discrepancy.status === "partial";
}

function discrepancyId(discrepancy: ValidationDiscrepancy, index: number): string {
	return discrepancy.id?.trim() || `discrepancy-${index + 1}`;
}

function discrepancyHeading(discrepancy: ValidationDiscrepancy, index: number): string {
	return `${discrepancyId(discrepancy, index)} — ${discrepancy.status}: ${discrepancy.item}`;
}

function discrepancyDetailLines(discrepancy: ValidationDiscrepancy): string[] {
	return [
		`why not done: ${discrepancy.reason || "(not provided)"}`,
		`worth implementing now: ${discrepancy.worthImplementingNow ? "yes" : "no"}`,
		`worthwhile rationale: ${discrepancy.worthwhileRationale || "(not provided)"}`,
		...(discrepancy.suggestedAction ? [`suggested action: ${discrepancy.suggestedAction}`] : []),
	];
}

function normalizeSelectorOptions(options: DiscrepancySelectorOptions): Required<DiscrepancySelectorOptions> {
	const actionableDiscrepancies = options.actionableDiscrepancies.filter(isActionableDiscrepancy);
	const actionableIds = new Set(actionableDiscrepancies.map(discrepancyId));
	const informationalDiscrepancies = (options.informationalDiscrepancies ?? []).filter(
		(discrepancy, index) => !actionableIds.has(discrepancyId(discrepancy, index)),
	);
	return {
		title: options.title.trim() || "Select validator discrepancies",
		actionableDiscrepancies,
		informationalDiscrepancies,
		introLines: options.introLines?.map((line) => line.trim()).filter(Boolean) ?? [],
	};
}

function selectedDiscrepanciesFromIds(
	actionableDiscrepancies: ValidationDiscrepancy[],
	selectedIds: Iterable<string>,
): ValidationDiscrepancy[] {
	const selectedSet = new Set(Array.from(selectedIds).map((id) => id.trim()).filter(Boolean));
	return actionableDiscrepancies.filter((discrepancy, index) => selectedSet.has(discrepancyId(discrepancy, index)));
}

export function renderDiscrepancySelectionEditorMarkdown(options: DiscrepancySelectorOptions): string {
	const normalized = normalizeSelectorOptions(options);
	const lines = [
		`# ${normalized.title}`,
		"",
		"Check the actionable discrepancies you want to implement in this pass.",
		"Leave unchecked items unresolved for now. Only checked actionable IDs will be selected.",
		...(normalized.introLines.length > 0 ? ["", ...normalized.introLines] : []),
		"",
		"## Actionable discrepancies",
		"",
	];

	if (normalized.actionableDiscrepancies.length === 0) {
		lines.push("No actionable discrepancies remain.");
	} else {
		normalized.actionableDiscrepancies.forEach((discrepancy, index) => {
			lines.push(`- [ ] \`${discrepancyId(discrepancy, index)}\` — ${discrepancy.status}: ${discrepancy.item}`);
			for (const detail of discrepancyDetailLines(discrepancy)) {
				lines.push(`  - ${detail}`);
			}
			lines.push("");
		});
	}

	lines.push("## Informational only (not selectable)", "");
	if (normalized.informationalDiscrepancies.length === 0) {
		lines.push("No informational discrepancies remain.");
	} else {
		normalized.informationalDiscrepancies.forEach((discrepancy, index) => {
			lines.push(`- \`${discrepancyId(discrepancy, index)}\` — ${discrepancy.status}: ${discrepancy.item}`);
			for (const detail of discrepancyDetailLines(discrepancy)) {
				lines.push(`  - ${detail}`);
			}
			lines.push("");
		});
	}

	lines.push(
		"## Notes",
		"",
		"- You can reorder or edit the notes, but keep the checkbox + discrepancy ID on actionable items you want to implement.",
		"- If you leave every actionable item unchecked, no discrepancy will be selected.",
	);
	return trimBlock(lines.join("\n"));
}

export function parseSelectedDiscrepancyIdsFromMarkdown(
	markdown: string,
	actionableDiscrepancies: ValidationDiscrepancy[],
): string[] {
	const actionableIds = new Set(actionableDiscrepancies.map(discrepancyId));
	const selectedIds = new Set<string>();
	for (const line of markdown.split(/\r?\n/u)) {
		const backtickMatch = line.match(CHECKED_BACKTICK_ID_PATTERN);
		if (backtickMatch?.[1]) {
			const id = backtickMatch[1].trim();
			if (actionableIds.has(id)) selectedIds.add(id);
			continue;
		}
		const plainMatch = line.match(CHECKED_PLAIN_ID_PATTERN);
		if (plainMatch?.[1]) {
			const id = plainMatch[1].trim();
			if (actionableIds.has(id)) selectedIds.add(id);
		}
	}
	return actionableDiscrepancies
		.map((discrepancy, index) => discrepancyId(discrepancy, index))
		.filter((id) => selectedIds.has(id));
}

async function selectActionableDiscrepanciesWithCustomUI(
	ctx: ExtensionContext,
	options: Required<DiscrepancySelectorOptions>,
): Promise<DiscrepancySelectorSubmitResult | DiscrepancySelectorCancelResult | undefined> {
	if (options.actionableDiscrepancies.length === 0) {
		return { kind: "submit", selectedIds: [] };
	}
	return await ctx.ui.custom<DiscrepancySelectorSubmitResult | DiscrepancySelectorCancelResult>(
		(tui, theme, _kb, done) => {
			let focus: "items" | "actions" = "items";
			let itemIndex = 0;
			let actionIndex = 0;
			let cachedLines: string[] | undefined;
			const selectedIds = new Set<string>();

			const refresh = (): void => {
				cachedLines = undefined;
				tui.requestRender();
			};

			const continueLabel = (): string =>
				selectedIds.size > 0 ? ` Continue with ${selectedIds.size} selected ` : " Back without selecting ";

			const renderActionChip = (label: string, active: boolean, enabled = true): string => {
				if (active) {
					return theme.bg("selectedBg", theme.fg(enabled ? "text" : "muted", label));
				}
				return theme.fg(enabled ? "accent" : "dim", label);
			};

			const toggleSelected = (): void => {
				const discrepancy = options.actionableDiscrepancies[itemIndex];
				if (!discrepancy) return;
				const id = discrepancyId(discrepancy, itemIndex);
				if (selectedIds.has(id)) selectedIds.delete(id);
				else selectedIds.add(id);
				refresh();
			};

			const submit = (): void => {
				done({
					kind: "submit",
					selectedIds: options.actionableDiscrepancies
						.map((discrepancy, index) => discrepancyId(discrepancy, index))
						.filter((id) => selectedIds.has(id)),
				});
			};

			const handleInput = (data: string): void => {
				if (matchesKey(data, Key.escape)) {
					done({ kind: "cancel" });
					return;
				}

				if (focus === "items") {
					if (matchesKey(data, Key.up)) {
						itemIndex = Math.max(0, itemIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						itemIndex = Math.min(options.actionableDiscrepancies.length - 1, itemIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						focus = "actions";
						actionIndex = 0;
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ") {
						toggleSelected();
					}
					return;
				}

				if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
					focus = "items";
					refresh();
					return;
				}
				if (matchesKey(data, Key.up)) {
					if (actionIndex === 0) focus = "items";
					else actionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
					actionIndex = actionIndex === 0 ? 1 : 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (actionIndex === 0) {
						submit();
						return;
					}
					done({ kind: "cancel" });
				}
			};

			const render = (width: number): string[] => {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const add = (text: string): void => lines.push(truncateToWidth(text, width));

				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("accent", ` ${theme.bold(options.title)}`));
				add(
					theme.fg(
						"muted",
						` ${options.actionableDiscrepancies.length} actionable • ${options.informationalDiscrepancies.length} informational`,
					),
				);
				for (const line of options.introLines) add(theme.fg("muted", ` ${line}`));
				lines.push("");
				add(theme.fg("text", " Actionable discrepancies"));
				lines.push("");

				options.actionableDiscrepancies.forEach((discrepancy, index) => {
					const active = focus === "items" && index === itemIndex;
					const id = discrepancyId(discrepancy, index);
					const checked = selectedIds.has(id);
					const prefix = active ? theme.fg("accent", "> ") : "  ";
					add(
						`${prefix}${theme.fg(active ? "accent" : "text", `${checked ? "[x]" : "[ ]"} ${discrepancyHeading(discrepancy, index)}`)}`,
					);
				});

				const focusedDiscrepancy = options.actionableDiscrepancies[itemIndex];
				if (focusedDiscrepancy) {
					lines.push("");
					add(theme.fg("text", " Focused item"));
					add(
						`   ${theme.fg("accent", discrepancyHeading(focusedDiscrepancy, itemIndex))}`,
					);
					for (const detail of discrepancyDetailLines(focusedDiscrepancy)) {
						add(`     ${theme.fg("muted", detail)}`);
					}
				}

				if (options.informationalDiscrepancies.length > 0) {
					lines.push("");
					add(theme.fg("muted", ` Informational only (${options.informationalDiscrepancies.length})`));
					options.informationalDiscrepancies.forEach((discrepancy, index) => {
						add(`   ${theme.fg("dim", discrepancyHeading(discrepancy, index))}`);
					});
				}

				lines.push("");
				const actions = [
					renderActionChip(continueLabel(), focus === "actions" && actionIndex === 0),
					renderActionChip(" Cancel ", focus === "actions" && actionIndex === 1),
				].join(theme.fg("dim", "   "));
				add(actions);
				add(
					theme.fg(
						selectedIds.size > 0 ? "muted" : "warning",
						selectedIds.size > 0
							? " Continue submits the checked items only."
							: " Back returns to the validator decision step without selecting any items.",
					),
				);
				lines.push("");
				add(theme.fg("dim", " ↑↓ navigate • Space/Enter toggle • Tab switch to actions • Esc cancel"));
				add(theme.fg("accent", "─".repeat(width)));

				cachedLines = lines;
				return lines;
			};

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
	);
}

async function selectActionableDiscrepanciesWithEditor(
	ctx: ExtensionContext,
	options: Required<DiscrepancySelectorOptions>,
): Promise<ValidationDiscrepancy[] | undefined> {
	const edited = await ctx.ui.editor(options.title, renderDiscrepancySelectionEditorMarkdown(options));
	if (edited === undefined) return undefined;
	return selectedDiscrepanciesFromIds(
		options.actionableDiscrepancies,
		parseSelectedDiscrepancyIdsFromMarkdown(edited, options.actionableDiscrepancies),
	);
}

export async function selectRemainingActionableDiscrepancies(
	ctx: ExtensionContext,
	options: DiscrepancySelectorOptions,
): Promise<ValidationDiscrepancy[] | undefined> {
	const normalized = normalizeSelectorOptions(options);
	if (normalized.actionableDiscrepancies.length === 0) return [];
	if (!ctx.hasUI) return undefined;

	const customResult = await selectActionableDiscrepanciesWithCustomUI(ctx, normalized);
	if (customResult?.kind === "submit") {
		return selectedDiscrepanciesFromIds(normalized.actionableDiscrepancies, customResult.selectedIds);
	}
	if (customResult?.kind === "cancel") return undefined;
	return await selectActionableDiscrepanciesWithEditor(ctx, normalized);
}
