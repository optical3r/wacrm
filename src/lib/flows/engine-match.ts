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
  validation: "any" | "email" | "phone" | "regex" | "media" | undefined,
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
    case "media":
      // A media answer is checked by readCollectedReply; typed text
      // never satisfies a "send a photo / audio / file" question.
      return false;
    default:
      return true;
  }
}

/** Default nudge when a text question gets a photo or audio. */
export const DEFAULT_MEDIA_REPLY_TEXT = "Por favor, responda por escrito.";

/**
 * What a reply to a collect_input question gives. Text is checked
 * against the format. Media (photo, audio, video, file, sticker) answers
 * a "media" question with its link; for any other question its caption
 * counts as the text, and media with no caption is flagged so the
 * engine can ask for a written answer.
 */
export function readCollectedReply(
  reply:
    | { kind: "text"; text: string }
    | { kind: "media"; media_kind: string; media_url?: string | null; caption?: string | null },
  validation: "any" | "email" | "phone" | "regex" | "media" | undefined,
  regex?: string,
): { captured: string; valid: boolean; mediaWithoutText: boolean } {
  if (reply.kind === "media" && validation === "media") {
    return { captured: reply.media_url || `[${reply.media_kind}]`, valid: true, mediaWithoutText: false };
  }
  const captured = (reply.kind === "text" ? reply.text : reply.caption ?? "").trim();
  return {
    captured,
    valid: isValidCollectedInput(captured, validation, regex),
    mediaWithoutText: reply.kind === "media" && captured === "",
  };
}

/** "HH:mm-HH:mm" → minutes since midnight, or null when malformed. */
export function parseHoursWindow(value: string | undefined): { from: number; to: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? "");
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

/**
 * Whether `now` falls inside the opening window, in `timezone`. A window
 * that crosses midnight ("18:00-09:00") works; its after-midnight part
 * belongs to the day it started on.
 */
export function isWithinBusinessHours(
  now: Date,
  args: { window?: string; days?: number[]; timezone?: string },
): boolean {
  const w = parseHoursWindow(args.window);
  if (!w) return false;
  let tz = args.timezone || "America/Sao_Paulo";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    tz = "America/Sao_Paulo";
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const days = args.days && args.days.length > 0 ? args.days : [0, 1, 2, 3, 4, 5, 6];
  if (w.from <= w.to) return days.includes(weekday) && mins >= w.from && mins < w.to;
  // Crosses midnight: evening part today, early part counts for yesterday.
  if (mins >= w.from) return days.includes(weekday);
  if (mins < w.to) return days.includes((weekday + 6) % 7);
  return false;
}

/** Wait node duration in ms, capped at 30 days. */
export function waitDurationMs(amount: unknown, unit: unknown): number {
  const n = Math.max(0, Number(amount) || 0);
  const unitMs = unit === "days" ? 86_400_000 : unit === "hours" ? 3_600_000 : 60_000;
  return Math.min(n * unitMs, 30 * 86_400_000);
}

/** "Name: value" lines → headers. Lines without a colon are skipped. */
export function parseHeaderLines(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(name)) out[name] = value;
  }
  return out;
}

/** Reads `a.b.c` out of nested objects/arrays; undefined when missing. */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Text form of a var for messages: objects become JSON. */
export function varToText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** "1.234,50", "R$ 10", "3.5" → number; null when it is not a number. */
export function parseLooseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  let s = v.replace(/[^\d,.-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  // "1.234,50" (pt-BR) → "1234.50"; "1,5" → "1.5".
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The test of one rule, once its subject is known. `subject` undefined
 * means absent (no such var, tag missing, empty field).
 */
export function rulePredicate(
  operator: string | undefined,
  subject: string | undefined,
  value: string | undefined,
): boolean {
  switch (operator) {
    case "present":
      return subject !== undefined && subject !== "";
    case "absent":
      return subject === undefined || subject === "";
    case "equals":
      return subject !== undefined && subject === (value ?? "");
    case "contains":
      return subject !== undefined && subject.includes(value ?? "");
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = parseLooseNumber(subject);
      const b = parseLooseNumber(value);
      if (a === null || b === null) return false;
      return operator === "gt" ? a > b : operator === "gte" ? a >= b : operator === "lt" ? a < b : a <= b;
    }
    default:
      return false;
  }
}

/** Combine rule results: all of them ("e") or any of them ("ou"). */
export function combineRules(results: boolean[], match: "all" | "any" | undefined): boolean {
  if (results.length === 0) return false;
  return match === "any" ? results.some(Boolean) : results.every(Boolean);
}
