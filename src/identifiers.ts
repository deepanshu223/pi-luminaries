function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphanumericCode(code: number): boolean {
  return isAsciiDigit(code) || isAsciiLetter(code);
}

function isLuminariesIdCode(code: number): boolean {
  return isAsciiAlphanumericCode(code) || code === 45 || code === 46 || code === 95;
}

function isHexCode(code: number): boolean {
  return isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** Luminaries map and public IDs: one through 64 ASCII characters with alphanumeric edges. */
export function isLuminariesId(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false;
  if (!isAsciiAlphanumericCode(value.charCodeAt(0)) || !isAsciiAlphanumericCode(value.charCodeAt(value.length - 1)))
    return false;
  for (let index = 1; index < value.length - 1; index++) if (!isLuminariesIdCode(value.charCodeAt(index))) return false;
  return true;
}

/** Pi session IDs use the same ASCII alphabet without Luminaries's 64-character map-key limit. */
export function isPiSessionId(value: string): boolean {
  if (value.length < 1) return false;
  if (!isAsciiAlphanumericCode(value.charCodeAt(0)) || !isAsciiAlphanumericCode(value.charCodeAt(value.length - 1)))
    return false;
  for (let index = 1; index < value.length - 1; index++) if (!isLuminariesIdCode(value.charCodeAt(index))) return false;
  return true;
}

export function isLowercaseSha256(value: string): boolean {
  if (value.length !== 64) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (!isAsciiDigit(code) && (code < 97 || code > 102)) return false;
  }
  return true;
}

/** Canonical UUID text with RFC variant and versions 1 through 8. */
export function isUuid(value: string): boolean {
  if (value.length !== 36 || value[8] !== '-' || value[13] !== '-' || value[18] !== '-' || value[23] !== '-')
    return false;
  for (let index = 0; index < value.length; index++) {
    if (index === 8 || index === 13 || index === 18 || index === 23) continue;
    if (!isHexCode(value.charCodeAt(index))) return false;
  }
  const version = value.charCodeAt(14);
  if (version < 49 || version > 56) return false;
  const variant = value[19]?.toLowerCase();
  return variant === '8' || variant === '9' || variant === 'a' || variant === 'b';
}

export function isAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** Controls that can alter terminal presentation without appearing as ordinary text. */
export function hasUnsafeHumanFacingControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069))
    )
      return true;
  }
  return false;
}
