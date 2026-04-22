import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	buildRenderOptions,
	normalizeQuestions,
	renderQuestionnaireResultText,
	type Answer,
	type Question,
	type QuestionInput,
	type QuestionnaireResult,
} from "./questionnaire-model.ts";

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below the option" })),
	recommended: Type.Optional(
		Type.Boolean({ description: "Whether this is the recommended option; recommended options are shown first" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the question" }),
	label: Type.Optional(
		Type.String({ description: "Short label for summaries, e.g. 'Scope', 'Audience', 'Rollout'" }),
	),
	prompt: Type.String({ description: "The full question shown to the user" }),
	options: Type.Array(QuestionOptionSchema, { description: "Concrete answer choices for the user" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Whether the user can type a custom answer. Prefer true." }),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Ask 1-4 focused clarifying questions" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function registerQuestionnaire(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more structured clarifying questions with multiple-choice answers and an optional custom response.",
		promptSnippet:
			"Ask grouped clarifying questions as multiple choice during planning and discovery, and mark the recommended option so it appears first.",
		promptGuidelines: [
			"Use questionnaire when the user needs to choose between materially different alternatives or confirm important assumptions.",
			"Resolve meaningful forks with questionnaire instead of carrying multiple options into the final plan.",
			"Do not use questionnaire for status updates, no-op acknowledgements, or to re-confirm work the user already approved.",
			"If the user already told you to proceed, do the work instead of asking whether to implement or whether to use the approved plan again.",
			"Ask at most 4 questions per batch, each with 2-6 concrete options and brief descriptions when helpful.",
			"When you have a clear default, mark that option as recommended so it is shown first. Leave allowOther enabled unless you have a strong reason to force predefined answers.",
		],
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions as QuestionInput[]);

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean): void {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions() {
					return buildRenderOptions(currentQuestion());
				}

				function allAnswered(): boolean {
					return questions.every((question) => answers.has(question.id));
				}

				function saveAnswer(question: Question, value: string, label: string, wasCustom: boolean, index?: number): void {
					answers.set(question.id, {
						id: question.id,
						questionLabel: question.label,
						questionPrompt: question.prompt,
						value,
						label,
						wasCustom,
						index,
					});
				}

				function advanceAfterAnswer(): void {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length;
					}
					optionIndex = 0;
					refresh();
				}

				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const question = questions.find((item) => item.id === inputQuestionId);
					if (!question) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(question, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string): void {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const question = currentQuestion();
					const options = currentOptions();

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(options.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter) && question) {
						const option = options[optionIndex];
						if (option.isOther) {
							inputMode = true;
							inputQuestionId = question.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(question, option.value, option.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const question = currentQuestion();
					const options = currentOptions();
					const add = (text: string) => lines.push(truncateToWidth(text, width));

					add(theme.fg("accent", "─".repeat(width)));

					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let index = 0; index < questions.length; index++) {
							const item = questions[index];
							const isActive = index === currentTab;
							const isAnswered = answers.has(item.id);
							const box = isAnswered ? "■" : "□";
							const tabText = ` ${box} ${item.label} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", tabText))
								: theme.fg(isAnswered ? "success" : "muted", tabText);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					function renderOptions(): void {
						for (let index = 0; index < options.length; index++) {
							const option = options[index];
							const selected = index === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const optionText = theme.fg(selected ? "accent" : "text", `${index + 1}. ${option.label}`);
							const recommendedText = option.recommended && !option.isOther ? ` ${theme.fg("success", "(recommended)")}` : "";
							const inputText = option.isOther && inputMode ? theme.fg(selected ? "accent" : "text", " ✎") : "";
							add(prefix + optionText + recommendedText + inputText);
							if (option.description) {
								add(`     ${theme.fg("muted", option.description)}`);
							}
						}
					}

					if (inputMode && question) {
						add(theme.fg("text", ` ${question.prompt}`));
						lines.push("");
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to go back"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Ready to submit")));
						lines.push("");
						for (const item of questions) {
							const answer = answers.get(item.id);
							if (!answer) continue;
							const prefix = answer.wasCustom ? "(wrote) " : "";
							add(
								`${theme.fg("muted", ` ${item.label}: `)}${theme.fg("text", prefix + answer.label)}`,
							);
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((item) => !answers.has(item.id))
								.map((item) => item.label)
								.join(", ");
							add(theme.fg("warning", ` Unanswered: ${missing}`));
						}
					} else if (question) {
						add(theme.fg("text", ` ${question.prompt}`));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						add(
							theme.fg(
								"dim",
								isMulti
									? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
									: " ↑↓ navigate • Enter select • Esc cancel",
							),
						);
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: renderQuestionnaireResultText(result) }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions as Question[]) || [];
			const labels = questions.map((question) => question.label || question.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				const value = answer.wasCustom ? `${theme.fg("muted", "(wrote) ")}${answer.label}` : `${answer.index}. ${answer.label}`;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.questionLabel)}: ${value}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
