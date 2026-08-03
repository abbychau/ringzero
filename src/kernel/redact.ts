/**
 * Secret redaction for tool outputs (zero-dep).
 *
 * Collects the values of environment variables whose names look like secrets
 * (keys/tokens/passwords/credentials/auth) plus URL userinfo, and replaces
 * their occurrences in text with [redacted]. Applied by the kernel to every
 * tool result before it reaches the model, the session store, or the UI.
 */
const SECRET_KEY_RE = /(^|_)(key|token|secret|password|passwd|credential|auth)(_|$)/i;

function collectSecrets(): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 6) continue;
    if (SECRET_KEY_RE.test(name) || /^API[_-]?KEY$/.test(name)) out.add(value);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Redact URL userinfo (scheme://user:pass@host) and known secret values. */
export function makeRedactor(): (text: string) => string {
  const secrets = collectSecrets();
  const urlCred = /(https?:\/\/)[^/\s@]+@/gi;
  return (text) => {
    let out = text.replace(urlCred, '$1[redacted]@');
    for (const s of secrets) {
      if (out.includes(s)) out = out.split(s).join('[redacted]');
    }
    return out;
  };
}
