/** Same-call semantic classification, never a substring/definition router.
 * The provider must distinguish conventional names and category examples from
 * substituting an unrelated subject. The server cannot prove this assessment.
 */
const SUBJECT_BINDINGS = [
  "direct", "conventional_name", "category_explanation", "context_ellipsis",
  "unrequested_substitution",
] as const;

export const SUBJECT_BINDING_SCHEMA = {
  type: "STRING",
  enum: [...SUBJECT_BINDINGS],
  description: "Classify the relationship of the entire answer to the requested subject before writing the answer. Shared spelling alone never establishes equivalence.",
};

export function acceptsSubjectBinding(binding: unknown): boolean {
  // Legacy responses/recordbook schema have no field. Do not retroactively
  // reject valid prose based on lexical overlap. New official generation
  // requires the field through its response schema; this is not semantic proof.
  if (binding === undefined) return true;
  return typeof binding === "string"
    && SUBJECT_BINDINGS.some(value => value === binding)
    && binding !== "unrequested_substitution";
}
