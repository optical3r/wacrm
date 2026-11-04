/**
 * "Assinar" (migration 056): when a number has sign_messages on, a text
 * sent from the inbox starts with the attendant's name in bold, the way
 * WhatsApp teams usually sign: "*Ana:*\nBom dia!". Pure, browser-safe.
 */
export function signText(name: string | null | undefined, text: string): string {
  const clean = (name ?? '').replace(/[*_~`\r\n]/g, '').trim()
  if (!clean || !text.trim()) return text
  const prefix = `*${clean}:*\n`
  return text.startsWith(prefix) ? text : prefix + text
}
