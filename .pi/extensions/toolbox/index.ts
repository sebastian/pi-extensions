import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerOrchestration from "./orchestration.ts";
import registerRateLimitHandling from "./rate-limit.ts";
import registerReviewCommand from "./review-workflow.ts";

export default function toolboxExtension(pi: ExtensionAPI): void {
	registerOrchestration(pi);
	registerReviewCommand(pi);
	registerRateLimitHandling(pi);
}
