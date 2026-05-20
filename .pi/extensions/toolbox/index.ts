import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerRateLimitHandling from "./rate-limit.ts";
import registerReviewCommand from "./review-workflow.ts";

export default function toolboxExtension(pi: ExtensionAPI): void {
	registerReviewCommand(pi);
	registerRateLimitHandling(pi);
}
