export interface BuildImplementationPromptOptions {
	extraInstructions: string;
	planPath?: string;
	inlinePlanText?: string;
}

export function isRedundantImplementationKickoffQuestionnaire(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const questions = (input as { questions?: unknown[] }).questions;
	if (!Array.isArray(questions) || questions.length === 0) return false;

	const redundantPattern =
		/\b(noop|status\d*|implementation mode|implement now|go ahead and implement|proceed with implementation|proceed with implementation now|approved plan.*sole source of truth|use the approved plan as the sole source of truth)\b/i;

	return questions.some((question) => {
		if (!question || typeof question !== "object") return false;
		const questionRecord = question as {
			id?: unknown;
			label?: unknown;
			prompt?: unknown;
			options?: Array<{ label?: unknown; value?: unknown; description?: unknown }>;
		};
		const optionText = Array.isArray(questionRecord.options)
			? questionRecord.options
					.map((option) => [option?.label, option?.value, option?.description].filter((part) => typeof part === "string").join(" "))
					.join(" ")
			: "";
		const text = [questionRecord.id, questionRecord.label, questionRecord.prompt, optionText]
			.filter((part) => typeof part === "string")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		return text.length > 0 && redundantPattern.test(text);
	});
}

export function buildImplementationPrompt(options: BuildImplementationPromptOptions): string {
	const instructions = [
		"Implement the approved plan from this session in a simple straight-line flow.",
		"Implementation is already approved.",
		"Do not ask whether you should implement, do not ask whether to use the approved plan, and do not use questionnaire for implementation-mode confirmations, status pings, or no-op acknowledgements.",
		"Start by rescanning the relevant files and then begin coding immediately.",
		"",
		"Workflow:",
		"1. Re-scan the relevant files, then implement the agreed plan directly in this main session.",
		"2. Only after the implementation pass is complete, run the review phase automatically.",
		"3. In that review phase, use the two strongest available models that were NOT used for implementation. Run those two reviews in parallel, at the highest reasoning level available, and ask them to look for as many concrete issues as possible across logic, regressions, side effects, security, UX, and missed plan requirements.",
		"4. Synthesize the two review outputs into one deduplicated findings list. Merge overlaps, keep the strongest wording/evidence, and preserve priority.",
		"5. Then switch back to the implementation model/original coding mode and immediately fix every P1-or-higher finding from that deduplicated review set without user intervention.",
		"6. Run one more automatic review pass after those fixes. Again prefer a different review model from the implementation model, use the highest reasoning level available, and stay focused on remaining concrete issues.",
		"7. Only if findings still remain after those automatic review/fix passes, present them to the user with questionnaire. Prefer one question per finding, batch up to 4 findings at a time, and give concrete choices like Fix now / Defer / Ignore.",
		"8. After the user answers, address only the findings they selected to fix now, and clearly summarize the ones they deferred or ignored.",
		"9. Keep the implementation simple. Do not invent extra orchestration or sub-agent workflows.",
	];
	if (options.inlinePlanText?.trim()) {
		instructions.push("", "Use the approved plan below as the source of truth.", "", options.inlinePlanText.trim());
	} else if (options.planPath) {
		instructions.push("", `Use ${options.planPath} as the source of truth for the latest approved plan.`);
	} else {
		instructions.push("", "Use the approved conversation context from this session as the source of truth; no PLAN.md file is available yet.");
	}
	instructions.push(
		"",
		"Follow the decision log and recommended approach established during discovery.",
		"Only ask a question before coding if there is a concrete blocking ambiguity that materially changes the agreed implementation. Otherwise, start implementing immediately.",
	);
	if (options.extraInstructions.trim()) {
		instructions.push("", `Additional instructions: ${options.extraInstructions.trim()}`);
	}
	return instructions.join("\n");
}
