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

export function matchesKey(input: string, key: string): boolean {
	if (key === Key.enter) return input === "\r" || input === "\n";
	return input === key;
}

export function visibleWidth(text: string): number {
	return [...text].length;
}

export function truncateToWidth(text: string, width: number, ellipsis = "…", trimLeft = false): string {
	const safeWidth = Math.max(0, Math.floor(width));
	const chars = [...text];
	if (chars.length <= safeWidth) return text;
	if (safeWidth === 0) return "";
	const ellipsisChars = [...ellipsis];
	if (ellipsisChars.length >= safeWidth) return ellipsisChars.slice(0, safeWidth).join("");
	const available = safeWidth - ellipsisChars.length;
	return trimLeft
		? `${ellipsis}${chars.slice(chars.length - available).join("")}`
		: `${chars.slice(0, available).join("")}${ellipsis}`;
}
