export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

export type RenderOption = QuestionOption & { isOther?: boolean };

export interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
}

export interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

export interface Answer {
	id: string;
	questionLabel: string;
	questionPrompt: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

export const QUESTIONNAIRE_DECISION_REMINDER =
	"Treat the selected answers above as agreed decisions. If another material choice still needs the user, ask it with questionnaire instead of burying alternatives in prose, and put the recommended option first. In the final plan, include only the selected path and do not restate rejected alternatives unless the user explicitly asks for them.";

export function sortRecommendedOptions(options: QuestionOption[]): QuestionOption[] {
	const recommended = options.filter((option) => option.recommended);
	if (recommended.length === 0) return [...options];
	return [...recommended, ...options.filter((option) => !option.recommended)];
}

export function normalizeQuestions(questions: QuestionInput[]): Question[] {
	return questions.map((question, index) => ({
		...question,
		label: question.label || `Q${index + 1}`,
		allowOther: question.allowOther !== false,
		options: sortRecommendedOptions(question.options),
	}));
}

export function buildRenderOptions(question: Question | undefined): RenderOption[] {
	if (!question) return [];
	const options: RenderOption[] = [...question.options];
	if (question.allowOther) {
		options.push({ value: "__other__", label: "Type something.", isOther: true });
	}
	return options;
}

export function formatQuestionnaireAnswer(answer: Answer): string {
	const prefix = `${answer.questionLabel}: `;
	return answer.wasCustom
		? `${prefix}user wrote: ${answer.label}`
		: `${prefix}user selected: ${answer.index}. ${answer.label}`;
}

export function renderQuestionnaireResultText(result: QuestionnaireResult): string {
	const answerLines = result.answers.map(formatQuestionnaireAnswer);
	return answerLines.length > 0
		? `${answerLines.join("\n")}\n\n${QUESTIONNAIRE_DECISION_REMINDER}`
		: QUESTIONNAIRE_DECISION_REMINDER;
}
