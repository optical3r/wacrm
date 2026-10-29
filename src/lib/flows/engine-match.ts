/**
 * Text folding shared by the runner's keyword match and the validator
 * (which also runs in the browser, so it must not import the engine).
 */

/**
 * Lower-cases and strips accents, so "Dúvida" and "duvida" match. Used
 * unless the trigger is case-sensitive.
 */
export function foldKeywordText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
