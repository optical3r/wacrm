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

/**
 * Whether a collect_input reply has the format the node asks for. Pure,
 * so the builder could reuse it. A regex that does not compile accepts
 * everything: a typo in the flow must not lock the customer out.
 */
export function isValidCollectedInput(
  text: string,
  validation: "any" | "email" | "phone" | "regex" | undefined,
  regex?: string,
): boolean {
  const value = text.trim();
  if (!value) return false;
  switch (validation) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
    case "phone": {
      // Digits plus the usual separators; 10-15 digits covers a local
      // number with area code up to a full E.164 number.
      if (!/^[+\d\s().-]+$/.test(value)) return false;
      const digits = value.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15;
    }
    case "regex": {
      if (!regex) return true;
      let re: RegExp;
      try {
        re = new RegExp(regex, "u");
      } catch {
        return true;
      }
      return re.test(value.slice(0, 1000));
    }
    default:
      return true;
  }
}
