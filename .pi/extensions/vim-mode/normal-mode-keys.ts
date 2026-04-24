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

export function normalizeParsedNormalModeKey(parsedKey: string | undefined, kittyPrintable?: string | undefined): string | undefined {
	if (kittyPrintable && kittyPrintable.length === 1) return kittyPrintable;
	if (!parsedKey) return undefined;
	const shiftMatch = /^shift\+(.+)$/u.exec(parsedKey);
	if (!shiftMatch) return parsedKey;
	const baseKey = shiftMatch[1] ?? "";
	if (/^[a-z]$/u.test(baseKey)) return baseKey.toUpperCase();
	return SHIFT_CHAR_MAP[baseKey] ?? parsedKey;
}
