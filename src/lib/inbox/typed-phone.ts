// A phone number typed in the inbox search ("Conversar com ..."), the
// way WhatsApp offers to open a chat with a number that isn't saved.
//
// People type Brazilian numbers the national way ("71 98888-7777",
// "(071) 98888-7777"), so without a leading + a 10 or 11 digit number is
// read as Brazilian (DDD + number) and gets the 55 country code. With a
// leading + the number is taken as international, as typed.

const NOISE = /[\s().-]/g;

/**
 * Digits-only international number (no +), or null when the text is not
 * a phone number. Letters anywhere mean it's a name search, not a number.
 */
export function parseTypedPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.trim().replace(NOISE, "");
  if (!compact) return null;
  const international = compact.startsWith("+");
  const digits = international ? compact.slice(1) : compact;
  if (!/^\d+$/.test(digits)) return null;

  let full: string;
  if (international) {
    full = digits;
  } else {
    // National trunk prefix ("0 71 ...", "071 ...") is dropped.
    const national = digits.replace(/^0+/, "");
    if (national.length === 10 || national.length === 11) {
      full = `55${national}`;
    } else if (national.startsWith("55") && (national.length === 12 || national.length === 13)) {
      full = national;
    } else {
      return null;
    }
  }

  if (!/^[1-9]\d{7,14}$/.test(full)) return null;
  // A Brazilian number is 55 + 2-digit DDD + 8 or 9 digits.
  if (full.startsWith("55") && full.length !== 12 && full.length !== 13) {
    return null;
  }
  return full;
}

/** "+55 71 98888-7777" for Brazilian numbers, "+<digits>" otherwise. */
export function formatTypedPhone(digits: string): string {
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const cut = rest.length - 4;
    return `+55 ${ddd} ${rest.slice(0, cut)}-${rest.slice(cut)}`;
  }
  return `+${digits}`;
}
