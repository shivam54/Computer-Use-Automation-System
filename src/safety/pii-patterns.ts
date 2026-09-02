/** Regex patterns for financial / identity PII visible in legacy bank UIs */
export const PII_TEXT_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\$\d{1,3}(?:,\d{3})*\.\d{2}/g, // currency
  /\bMember Name:\s*[^\n]+/gi,
  /\bSavings Balance:\s*\$[^\n]+/gi,
  /\bChecking Balance:\s*\$[^\n]+/gi,
  /\bAccount Number:\s*\d+/gi,
  /\bMember Number:\s*\d+/gi,
  /\bStatus:\s*(?:active|frozen)\b/gi,
];

/** Extract PII substrings from plain text (for tests and log scanning) */
export function extractPiiSubstrings(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PII_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.add(match[0].trim());
    }
  }
  return [...found];
}

/** True if element text likely contains regulated PII worth blurring */
export function textContainsPii(text: string): boolean {
  return PII_TEXT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
