export const Key = {
	escape: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	left: "\u001b[D",
	right: "\u001b[C",
	tab: "\t",
	enter: "\r",
	space: " ",
	shift: (key: string): string => (key.toLowerCase() === "tab" ? "\u001b[Z" : key),
};

const ANSI_ESCAPE_PREFIX = /^(?:\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\))/u;
const ANSI_SGR_PREFIX = /^\u001B\[[0-9;]*m$/u;
const ANSI_RESET_PREFIX = /^\u001B\[(?:0;?)*m$|^\u001B\[m$/u;
const ANSI_RESET = "\u001b[0m";

interface DisplayToken {
	value: string;
	visible: boolean;
}

export function matchesKey(input: string, key: string): boolean {
	if (key === Key.enter) return input === "\r" || input === "\n";
	return input === key;
}

function readAnsiToken(text: string, offset: number): string | null {
	const match = text.slice(offset).match(ANSI_ESCAPE_PREFIX);
	return match?.[0] ?? null;
}

function tokenizeDisplay(text: string): DisplayToken[] {
	const tokens: DisplayToken[] = [];
	for (let offset = 0; offset < text.length;) {
		const ansi = readAnsiToken(text, offset);
		if (ansi) {
			tokens.push({ value: ansi, visible: false });
			offset += ansi.length;
			continue;
		}
		const codePoint = text.codePointAt(offset);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		tokens.push({ value: char, visible: true });
		offset += char.length;
	}
	return tokens;
}

function countVisibleTokens(tokens: DisplayToken[]): number {
	return tokens.reduce((total, token) => total + (token.visible ? 1 : 0), 0);
}

function updateSgrState(state: string[], token: string): string[] {
	if (!ANSI_SGR_PREFIX.test(token)) return state;
	if (ANSI_RESET_PREFIX.test(token)) return [];
	return [...state, token];
}

function truncateAnsiAware(text: string, width: number, ellipsis: string, trimLeft: boolean): string {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return "";
	const ellipsisChars = [...ellipsis];
	if (ellipsisChars.length >= safeWidth) return ellipsisChars.slice(0, safeWidth).join("");

	const tokens = tokenizeDisplay(text);
	const visibleCount = countVisibleTokens(tokens);
	if (visibleCount <= safeWidth) return text;
	const keepVisible = safeWidth - ellipsisChars.length;
	if (keepVisible <= 0) return ellipsisChars.slice(0, safeWidth).join("");

	if (!trimLeft) {
		let remaining = keepVisible;
		let output = "";
		let activeSgr: string[] = [];
		for (const token of tokens) {
			if (!token.visible) {
				output += token.value;
				activeSgr = updateSgrState(activeSgr, token.value);
				continue;
			}
			if (remaining <= 0) break;
			output += token.value;
			remaining -= 1;
		}
		if (activeSgr.length > 0) output += ANSI_RESET;
		return `${output}${ellipsis}`;
	}

	const visibleStart = visibleCount - keepVisible;
	let seenVisible = 0;
	let startIndex = tokens.length;
	let activeBeforeStart: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!token.visible) {
			activeBeforeStart = updateSgrState(activeBeforeStart, token.value);
			continue;
		}
		if (seenVisible === visibleStart) {
			startIndex = index;
			break;
		}
		seenVisible += 1;
	}
	if (startIndex === tokens.length) return ellipsis;
	let output = ellipsis;
	if (activeBeforeStart.length > 0) output += activeBeforeStart.join("");
	let activeSgr = [...activeBeforeStart];
	for (let index = startIndex; index < tokens.length; index++) {
		const token = tokens[index]!;
		output += token.value;
		if (!token.visible) activeSgr = updateSgrState(activeSgr, token.value);
	}
	if (activeSgr.length > 0) output += ANSI_RESET;
	return output;
}

export function visibleWidth(text: string): number {
	return countVisibleTokens(tokenizeDisplay(text));
}

export function truncateToWidth(text: string, width: number, ellipsis = "…", trimLeft = false): string {
	const safeWidth = Math.max(0, Math.floor(width));
	if (visibleWidth(text) <= safeWidth) return text;
	return truncateAnsiAware(text, safeWidth, ellipsis, trimLeft);
}

export function padToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const padding = safeWidth - visibleWidth(text);
	if (padding <= 0) return text;
	return `${text}${" ".repeat(padding)}`;
}
