/*
 * hls-pipe — HLS tag attribute parser
 *
 * Inspired by hls.js src/utils/attr-list.ts. Fresh implementation.
 * The grammar comes from RFC 8216 §4.2: attribute lists are comma-separated
 * AttributeName=AttributeValue pairs where values are one of:
 *   - quoted-string:        "foo"
 *   - hexadecimal-sequence: 0xDEADBEEF
 *   - decimal-integer:      12345
 *   - decimal-floating-point: 1.23
 *   - signed-decimal:       -42
 *   - enumerated-string:    BAR  (no quotes, no commas)
 *   - decimal-resolution:   1280x720
 *
 * Commas inside quoted strings are NOT separators.
 */

export type AttrValue = string;

export class AttrList {
  private readonly attrs: Map<string, AttrValue>;

  constructor(input: string) {
    this.attrs = parseAttrList(input);
  }

  has(name: string): boolean {
    return this.attrs.has(name);
  }

  /** Returns the raw value as parsed (quotes stripped, hex preserved as 0x...). */
  get(name: string): string | undefined {
    return this.attrs.get(name);
  }

  /** Decimal-integer (or hex). Returns undefined if absent or unparseable. */
  int(name: string): number | undefined {
    const v = this.attrs.get(name);
    if (v === undefined) return undefined;
    if (v.startsWith('0x') || v.startsWith('0X')) {
      const n = parseInt(v.slice(2), 16);
      return Number.isFinite(n) ? n : undefined;
    }
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }

  /** Decimal-floating-point. */
  float(name: string): number | undefined {
    const v = this.attrs.get(name);
    if (v === undefined) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /** Decimal-resolution: WIDTHxHEIGHT. */
  resolution(name: string): { width: number; height: number } | undefined {
    const v = this.attrs.get(name);
    if (v === undefined) return undefined;
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (!m) return undefined;
    return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
  }

  /** YES/NO enumerated-string → boolean. */
  bool(name: string, defaultValue = false): boolean {
    const v = this.attrs.get(name);
    if (v === undefined) return defaultValue;
    return v === 'YES';
  }

  /** Hex sequence (0x...) → Uint8Array. */
  hex(name: string): Uint8Array | undefined {
    const v = this.attrs.get(name);
    if (v === undefined || !(v.startsWith('0x') || v.startsWith('0X'))) return undefined;
    let h = v.slice(2);
    if (h.length % 2 !== 0) h = '0' + h;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(h.substr(i * 2, 2), 16);
    }
    return out;
  }
}

/**
 * Parse a single attribute list (the tail of e.g. `#EXT-X-STREAM-INF:...`).
 * Quoted strings preserve their content verbatim and may contain commas.
 */
function parseAttrList(input: string): Map<string, AttrValue> {
  const out = new Map<string, string>();
  let i = 0;
  const n = input.length;
  while (i < n) {
    // Skip leading whitespace/commas
    while (i < n && (input.charCodeAt(i) === 32 || input.charCodeAt(i) === 9 || input[i] === ',')) i++;
    if (i >= n) break;

    // Read NAME up to '='
    const nameStart = i;
    while (i < n && input[i] !== '=') i++;
    if (i >= n) break; // malformed; stop quietly
    const name = input.slice(nameStart, i).trim();
    i++; // consume '='

    // Read VALUE: quoted or unquoted
    let value: string;
    if (input[i] === '"') {
      i++;
      const valStart = i;
      while (i < n && input[i] !== '"') i++;
      value = input.slice(valStart, i);
      if (i < n) i++; // consume closing '"'
    } else {
      const valStart = i;
      while (i < n && input[i] !== ',') i++;
      value = input.slice(valStart, i).trim();
    }
    if (name) out.set(name, value);
  }
  return out;
}
