/**
 * Redaction for anything that leaves the process: logs, reports, artefacts.
 * Conservative: better to over-redact a log line than to ship a token.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._\-+/=]{16,}/gi, '$1$2<redacted>'],
  [/(cookie\s*[:=]\s*)[^\n]+/gi, '$1<redacted>'],
  [/\b(sk|rk|pk|dai|fc|ghp|gho|ghu|ghs|glpat|xoxb|xoxp)[-_][A-Za-z0-9_\-]{16,}\b/g, '<redacted-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  [/\b[a-f0-9]{32}\b(?=.*(secret|key|token))/gi, '<redacted-hex>'],
  [/(api[_-]?key|secret|token|password|passwd|pwd)(["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1$2<redacted>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'],
  [/(https?:\/\/[^\s/]+)\/[^\s]*(X-Amz-Signature|Signature|sig|token)=[^\s&]+/gi, '$1/<redacted-signed-url>'],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** True if the text still looks like it carries a secret after redaction. */
export function looksSecret(input: string): boolean {
  return /<redacted/.test(redact(input)) || /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(input);
}
