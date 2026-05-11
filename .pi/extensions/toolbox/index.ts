import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerReviewCommand from "./review-workflow.ts";

export default function toolboxExtension(pi: ExtensionAPI): void {
	registerReviewCommand(pi);
}
