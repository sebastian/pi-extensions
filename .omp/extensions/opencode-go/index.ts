import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function opencodeGo(pi: ExtensionAPI): void {
	pi.registerProvider("opencode-go", { apiKey: "OPENCODE_GO_API_KEY" });
}
