import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

function readCliModeArg(argv: readonly string[]): string | null {
	let mode: string | null = null;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--mode") {
			mode = argv[index + 1] ?? null;
			continue;
		}
		if (arg?.startsWith("--mode=")) mode = arg.slice("--mode=".length);
	}
	return mode;
}

function isRpcModeProcess(argv: readonly string[] = process.argv): boolean {
	return readCliModeArg(argv) === "rpc";
}

export function supportsStructuredImplementationWidget(
	ctx: Pick<ExtensionContext, "hasUI">,
	argv: readonly string[] = process.argv,
): boolean {
	return ctx.hasUI && !isRpcModeProcess(argv);
}
