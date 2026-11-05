"use client";

import { useLocale } from "next-intl";
import type { Locale } from "date-fns";
import { enUS, es, ko, ptBR } from "date-fns/locale";

const DATE_FNS: Record<string, Locale> = { pt: ptBR, en: enUS, es, ko };
const INTL: Record<string, string> = { pt: "pt-BR", en: "en-US", es: "es", ko: "ko-KR" };

/**
 * The app's language for dates: `dateLocale` for date-fns (`format`,
 * `formatDistanceToNow`), `intlLocale` for `toLocaleDateString`. Without
 * it date-fns prints English ("9 minutes ago", "November 5").
 */
export function useDateLocale(): { dateLocale: Locale; intlLocale: string } {
  const locale = useLocale();
  return { dateLocale: DATE_FNS[locale] ?? ptBR, intlLocale: INTL[locale] ?? "pt-BR" };
}
