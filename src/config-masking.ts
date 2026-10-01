/**
 * Line-preserving secret masking for yaml/properties files (#383 follow-up).
 *
 * `codegraph_node` file mode used to refuse config files outright and point the
 * agent at Read — but an agent that has ONLY codegraph (no filesystem tools)
 * was then left unable to see a feature flag or a port. This renders the file
 * with its real line numbers, keys as written and harmless values shown, while
 * anything secret-shaped is replaced by {@link REDACTED}:
 *   - every value under a secret-named key (password, token, api-key, …),
 *     including its block-scalar lines, list items and line continuations;
 *   - the password part of a URL with credentials (`scheme://user:pw@host`);
 *   - long opaque tokens (keys, hashes) under any key;
 *   - every line of a PEM block;
 *   - commented-out pairs, by the same rules.
 * Booleans/null and a bare `${ENV}` placeholder stay visible even under a
 * secret key — they carry no secret and say how the value is wired.
 *
 * The other #383 guards are unchanged: explore and symbol-mode node still never
 * render a config file's source unbidden. This is the deliberate pull.
 */

export const REDACTED = '<redacted>';

export interface MaskedConfig {
  text: string;
  /** Number of lines that had something masked. */
  masked: number;
}

const SECRET_KEY =
  /(passw|pwd|secret|token|credential|passphrase|apikey|privatekey|accesskey|secretkey|signingkey|encryptionkey|masterkey|clientkey|salt|jwt|bearer|cookie|connectionstring|dsn$)/;

export function isSecretKey(key: string): boolean {
  const last = key.replace(/^["']|["']$/g, '').split('.').pop() ?? key;
  return SECRET_KEY.test(last.toLowerCase().replace(/[-_\s]/g, ''));
}

const HARMLESS = /^(true|false|yes|no|on|off|null|~)$/i;
const BARE_PLACEHOLDER = /^\$\{[^:}]+\}$/;
const URL_CREDS = /(\/\/[^/\s:@]+:)([^@\s/]+)(@)/g;

function unquote(v: string): string {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** A long run of key/hash/base64 characters with both letters and digits. */
function looksOpaque(v: string): boolean {
  if (v.length < 20 || v.startsWith('/') || !/^[A-Za-z0-9+/=_-]+$/.test(v)) return false;
  return (v.match(/[0-9]/g)?.length ?? 0) >= 3 && (v.match(/[A-Za-z]/g)?.length ?? 0) >= 3;
}

/** The masked form of a scalar value, or null when it is shown as written. */
function maskValue(raw: string, secretKey: boolean): string | null {
  if (raw === '') return null;
  const v = unquote(raw);
  if (secretKey) return HARMLESS.test(v) || BARE_PLACEHOLDER.test(v) ? null : REDACTED;
  if (/^[{[]/.test(v)) {
    const keys = [...v.matchAll(/([\w.-]+)\s*[:=]/g)].map((m) => m[1]!);
    if (keys.some(isSecretKey)) return REDACTED;
  }
  if (URL_CREDS.test(raw)) {
    URL_CREDS.lastIndex = 0;
    return raw.replace(URL_CREDS, `$1${REDACTED}$3`);
  }
  return looksOpaque(v) ? REDACTED : null;
}

/** Splits a yaml value from a trailing ` # comment`. */
function splitYamlComment(rest: string): [string, string] {
  if (/^["']/.test(rest)) {
    const close = rest.indexOf(rest[0]!, 1);
    if (close > 0) return [rest.slice(0, close + 1), rest.slice(close + 1)];
  }
  const m = /\s#/.exec(rest);
  return m ? [rest.slice(0, m.index), rest.slice(m.index)] : [rest, ''];
}

const YAML_PAIR = /^(\s*)(-\s+)?("[^"]*"|'[^']*'|[^\s#'"][^:#]*?)(\s*:)(\s+|$)(.*)$/;
const YAML_ITEM = /^(\s*)(-\s+)(.*)$/;
const PROPS_PAIR = /^(\s*)((?:\\.|[^=:\s\\])+)(\s*[=:]\s*|\s+)(.*)$/;

function maskYaml(lines: string[]): number {
  let masked = 0;
  const parents: { indent: number; secret: boolean }[] = [];
  let block: { indent: number; secret: boolean } | null = null;
  let inPem = false;

  const indentOf = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => l.trim() === '';
  const replaceBody = (l: string) => l.slice(0, indentOf(l)) + REDACTED;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (block && (blank(line) || indentOf(line) > block.indent)) {
      if (blank(line)) continue;
      if (block.secret || inPem || line.includes('-----BEGIN')) {
        inPem = (inPem || line.includes('-----BEGIN')) && !line.includes('-----END');
        lines[i] = replaceBody(line);
        masked++;
      }
      continue;
    }
    block = null;
    inPem = false;
    if (blank(line)) continue;

    const comment = /^(\s*#\s?)(.*)$/.exec(line);
    if (comment) {
      const pair = YAML_PAIR.exec(comment[2]!);
      if (pair) {
        const [value, tail] = splitYamlComment(pair[6]!);
        const m = maskValue(value.trim(), isSecretKey(pair[3]!));
        if (m !== null) {
          lines[i] = comment[1]! + pair[1]! + (pair[2] ?? '') + pair[3]! + pair[4]! + pair[5]! + m + tail;
          masked++;
        }
      }
      continue;
    }

    const pair = YAML_PAIR.exec(line);
    if (pair) {
      const indent = pair[1]!.length + (pair[2]?.length ?? 0);
      while (parents.length && parents[parents.length - 1]!.indent >= indent) parents.pop();
      const secret = isSecretKey(pair[3]!);
      const [value, tail] = splitYamlComment(pair[6]!);
      const v = value.trim();
      const head = pair[1]! + (pair[2] ?? '') + pair[3]! + pair[4]! + pair[5]!;
      if (/^[|>][-+0-9]*$/.test(v)) {
        block = { indent, secret };
        if (secret) {
          lines[i] = head + REDACTED + tail;
          masked++;
        }
        continue;
      }
      if (v === '') {
        parents.push({ indent, secret });
        continue;
      }
      const m = maskValue(v, secret);
      if (m !== null) {
        lines[i] = head + m + tail;
        masked++;
      }
      continue;
    }

    const item = YAML_ITEM.exec(line);
    if (item) {
      const indent = item[1]!.length;
      while (parents.length && parents[parents.length - 1]!.indent > indent) parents.pop();
      const secret = parents[parents.length - 1]?.secret ?? false;
      const [value, tail] = splitYamlComment(item[3]!);
      const m = maskValue(value.trim(), secret);
      if (m !== null) {
        lines[i] = item[1]! + item[2]! + m + tail;
        masked++;
      }
    }
  }
  return masked;
}

function maskProperties(lines: string[]): number {
  let masked = 0;
  let continuing = false;
  let maskingContinuation = false;
  const continues = (l: string) => /(^|[^\\])(\\\\)*\\$/.test(l);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (continuing) {
      continuing = continues(line);
      if (maskingContinuation && line.trim() !== '') {
        lines[i] = line.slice(0, line.length - line.trimStart().length) + REDACTED;
        masked++;
      }
      continue;
    }
    const comment = /^(\s*[#!]\s?)(.*)$/.exec(line);
    const body = comment ? comment[2]! : line;
    const pair = PROPS_PAIR.exec(body);
    if (!pair) continue;
    const value = pair[4]!;
    const isCont = !comment && continues(value);
    const m = maskValue((isCont ? value.slice(0, -1) : value).trim(), isSecretKey(pair[2]!));
    if (m !== null) {
      lines[i] = (comment ? comment[1]! : '') + pair[1]! + pair[2]! + pair[3]! + m;
      masked++;
    }
    continuing = isCont;
    maskingContinuation = isCont && m !== null;
  }
  return masked;
}

export function maskConfigSource(content: string, language: string): MaskedConfig {
  const lines = content.split('\n');
  const masked = language === 'properties' ? maskProperties(lines) : maskYaml(lines);
  return { text: lines.join('\n'), masked };
}
