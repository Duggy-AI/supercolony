export const SUBMISSION_ATTRIBUTION = 'via supercolony';

export function withSubmissionAttribution(input) {
  if (typeof input.objective !== 'string' || !input.objective.trim()) return input;
  const objective = input.objective.trimEnd();
  if (objective === SUBMISSION_ATTRIBUTION || objective.endsWith('\n' + SUBMISSION_ATTRIBUTION)) return input;
  return { ...input, objective: objective + '\n' + SUBMISSION_ATTRIBUTION };
}
