import test from "node:test";
import assert from "node:assert/strict";
import {
	QUESTIONNAIRE_DECISION_REMINDER,
	buildRenderOptions,
	normalizeQuestions,
	renderQuestionnaireResultText,
} from "../questionnaire-model.ts";

test("normalizeQuestions moves recommended options to the front and keeps Other last", () => {
	const [question] = normalizeQuestions([
		{
			id: "scope",
			prompt: "Which scope should we ship first?",
			options: [
				{ value: "all", label: "Ship the full workflow" },
				{ value: "mvp", label: "Ship the smallest safe slice", recommended: true },
			],
		},
	]);

	assert.equal(question.label, "Q1");
	assert.equal(question.allowOther, true);
	assert.deepEqual(question.options.map((option) => option.label), [
		"Ship the smallest safe slice",
		"Ship the full workflow",
	]);

	const renderOptions = buildRenderOptions(question);
	assert.deepEqual(renderOptions.map((option) => option.label), [
		"Ship the smallest safe slice",
		"Ship the full workflow",
		"Type something.",
	]);
	assert.equal(renderOptions[0].recommended, true);
	assert.equal(renderOptions[2].isOther, true);
});

test("renderQuestionnaireResultText reminds the model to keep the final plan agreed-only", () => {
	const text = renderQuestionnaireResultText({
		questions: [],
		cancelled: false,
		answers: [
			{
				id: "scope",
				questionLabel: "Scope",
				questionPrompt: "Which scope should we ship first?",
				value: "mvp",
				label: "Ship the smallest safe slice",
				wasCustom: false,
				index: 1,
			},
		],
	});

	assert.match(text, /^Scope: user selected: 1\. Ship the smallest safe slice/m);
	assert.match(text, /Treat the selected answers above as agreed decisions\./);
	assert.match(text, /put the recommended option first/i);
	assert.match(text, /include only the selected path/i);
	assert.equal(text.endsWith(QUESTIONNAIRE_DECISION_REMINDER), true);
});
