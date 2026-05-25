/*
 * hls-pipe — ISO Base Media File Format (ISO/IEC 14496-12) box parser
 *
 * Fresh implementation. The ISO BMFF format underlies fMP4 / CMAF / MP4 /
 * 3GP / Quicktime. A "box" is the universal unit:
 *
 *   bytes 0-3   size (big-endian uint32)
 *   bytes 4-7   type (4-char ASCII, e.g., "moof", "mdat")
 *   bytes 8-?   payload (depends on type)
 *
 * Special size values:
 *   size = 0       box extends to end of file
 *   size = 1       extended size: next 8 bytes are uint64 size
 *
 * Some boxes are "full boxes" — their first 4 payload bytes are version+flags:
 *   byte 0       version
 *   bytes 1-3    flags (big-endian 24-bit)
 *
 * hls.js parallel: src/utils/mp4-tools.ts has its own box helpers, but they're
 * tightly coupled to hls.js's track model. We write fresh because (a) we
 * traverse boxes lazily rather than building a full tree, and (b) we only
 * need a small subset of box types for phases 7b.1-7b.2.
 */

/** A single box's framing — payload is `data.subarray(payloadOffset, end)`. */
export interface Box {
  type: string;
  /** Absolute offset of the box's first byte (the size field) inside the source buffer. */
  offset: number;
  /** Offset of the first byte AFTER the box (= offset + total size). */
  end: number;
  /** Offset of the first payload byte (skipping size + type, and extended-size if present). */
  payloadOffset: number;
  /** Reference to the original buffer for slicing. */
  data: Uint8Array;
}

/** Read the 4-byte type field at `offset+4` as ASCII. */
export function readType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset + 4]!,
    data[offset + 5]!,
    data[offset + 6]!,
    data[offset + 7]!,
  );
}

/** Parse one box header starting at `offset`. */
export function readBox(data: Uint8Array, offset: number): Box {
  if (offset + 8 > data.byteLength) {
    throw new BoxParseError(`truncated box header at offset ${offset}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let size = view.getUint32(offset, false);
  const type = readType(data, offset);
  let payloadOffset = offset + 8;

  if (size === 1) {
    // Extended 64-bit size — read next 8 bytes.
    if (offset + 16 > data.byteLength) {
      throw new BoxParseError(`truncated extended-size box header at offset ${offset}`);
    }
    const hi = view.getUint32(offset + 8, false);
    const lo = view.getUint32(offset + 12, false);
    // We don't expect boxes > 2^53 bytes in practice; warn if so.
    if (hi !== 0 && hi > 0x001fffff) {
      throw new BoxParseError(`box at offset ${offset} too large for JS Number representation`);
    }
    size = hi * 0x100000000 + lo;
    payloadOffset = offset + 16;
  } else if (size === 0) {
    // Box extends to end of file.
    size = data.byteLength - offset;
  }

  if (size < 8) {
    throw new BoxParseError(`box at offset ${offset} has invalid size ${size}`);
  }
  if (offset + size > data.byteLength) {
    throw new BoxParseError(
      `box "${type}" at offset ${offset} claims size ${size} but only ${data.byteLength - offset} bytes remain`,
    );
  }

  return { type, offset, end: offset + size, payloadOffset, data };
}

/** Iterate every top-level box in `data`. */
export function* iterateBoxes(data: Uint8Array): Iterable<Box> {
  let cursor = 0;
  while (cursor < data.byteLength) {
    const box = readBox(data, cursor);
    yield box;
    cursor = box.end;
  }
}

/** Iterate every direct child box inside a parent's payload. */
export function* iterateChildren(parent: Box): Iterable<Box> {
  let cursor = parent.payloadOffset;
  while (cursor < parent.end) {
    const child = readBox(parent.data, cursor);
    yield child;
    cursor = child.end;
  }
}

/** Find first top-level box of given type, or undefined. */
export function findBox(data: Uint8Array, type: string): Box | undefined {
  for (const box of iterateBoxes(data)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** Find first child box of given type within a parent, or undefined. */
export function findChild(parent: Box, type: string): Box | undefined {
  for (const child of iterateChildren(parent)) {
    if (child.type === type) return child;
  }
  return undefined;
}

/** Find all direct children of a given type. */
export function findChildren(parent: Box, type: string): Box[] {
  const out: Box[] = [];
  for (const child of iterateChildren(parent)) {
    if (child.type === type) out.push(child);
  }
  return out;
}

/**
 * Descend a dotted path of box types from `data` root.
 * `findPath(bytes, 'moov.trak.mdia.minf.stbl.stsd')` returns the stsd box, or undefined.
 */
export function findPath(data: Uint8Array, path: string): Box | undefined {
  const parts = path.split('.');
  let current = findBox(data, parts[0]!);
  for (let i = 1; current && i < parts.length; i++) {
    current = findChild(current, parts[i]!);
  }
  return current;
}

/** Payload slice of a box (excluding header). */
export function boxPayload(box: Box): Uint8Array {
  return box.data.subarray(box.payloadOffset, box.end);
}

/**
 * Read version + 24-bit flags for a "full box". Returns
 * `{ version, flags, payloadAfter }` where `payloadAfter` is the offset
 * inside `box.data` immediately after the version+flags word.
 */
export function readFullBoxHeader(box: Box): { version: number; flags: number; payloadAfter: number } {
  const o = box.payloadOffset;
  const view = new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);
  const versionFlags = view.getUint32(o, false);
  return {
    version: (versionFlags >>> 24) & 0xff,
    flags: versionFlags & 0xffffff,
    payloadAfter: o + 4,
  };
}

export class BoxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxParseError';
  }
}
