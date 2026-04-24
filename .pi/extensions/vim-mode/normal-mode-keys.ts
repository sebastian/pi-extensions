const SHIFT_CHAR_MAP: Record<string, string> = {
	"1": "!",
	"2": "@",
	"3": "#",
	"4": "$",
	"5": "%",
	"6": "^",
	"7": "&",
	"8": "*",
	"9": "(",
	"0": ")",
	"`": "~",
	"-": "_",
	"=": "+",
	"[": "{",
	"]": "}",
	"\\": "|",
	";": ":",
	"'": '"',
	",": "<",
	".": ">",
	"/": "?",
};

function normalizeShiftedKey(parsedKey: string): string {
	const shiftMatch = /^shift\+(.+)$/u.exec(parsedKey);
	if (!shiftMatch) return parsedKey;
	const baseKey = shiftMatch[1] ?? "";
	if (/^[a-z]$/u.test(baseKey)) return baseKey.toUpperCase();
	return SHIFT_CHAR_MAP[baseKey] ?? parsedKey;
}

function stripAltModifierForEscRecovery(parsedKey: string): string {
	const parts = parsedKey.split("+");
	if (!parts.includes("alt") || parts.includes("ctrl") || parts.includes("super")) return parsedKey;
	return parts.filter((part) => part !== "alt").join("+");
}

export function normalizeParsedNormalModeKey(
	parsedKey: string | undefined,
	kittyPrintable?: string | undefined,
	options?: { recoveringFromInsertEscape?: boolean },
): string | undefined {
	if (kittyPrintable && kittyPrintable.length === 1) return kittyPrintable;
	if (!parsedKey) return undefined;
	const candidate = options?.recoveringFromInsertEscape ? stripAltModifierForEscRecovery(parsedKey) : parsedKey;
	return normalizeShiftedKey(candidate);
}
