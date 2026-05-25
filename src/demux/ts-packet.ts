/*
 * hls-pipe — MPEG-TS packet primitives
 *
 * Direct port of bit-level packet header parsing from hls.js
 *   src/demux/tsdemuxer.ts (functions `parsePID`, `syncOffset`, packet loop)
 *
 * Modifications from upstream:
 *   - extracted to a standalone module (upstream inlined these in the class)
 *   - removed event-bus / logger dependencies
 *   - syncOffset has the same semantics; the integrity-check window is
 *     identical (length-1 packet at minimum, looking for 0x47 + 0x47 188
 *     bytes ahead, with a heuristic about how far to scan)
 *
 * Algorithm is byte-for-byte equivalent to upstream as of hls.js v1.6.x.
 *
 * ---------------------------------------------------------------------------
 * Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * ---------------------------------------------------------------------------
 */

/** MPEG-TS packet size in bytes. */
export const PACKET_LENGTH = 188;
/** Sync byte at the start of every TS packet. */
export const SYNC_BYTE = 0x47;

/** Well-known PIDs. */
export const PID_PAT = 0x0000;
export const PID_NULL = 0x1fff;

/**
 * Parse the 13-bit PID at the given byte offset (start of TS packet).
 * Layout: TS[1] low 5 bits + TS[2] all 8 bits.
 */
export function parsePID(data: Uint8Array, offset: number): number {
  return ((data[offset + 1]! & 0x1f) << 8) + data[offset + 2]!;
}

/**
 * Find the byte offset of the first valid TS packet start (sync byte 0x47).
 * Returns -1 if no valid alignment is found.
 *
 * Heuristic: look for two consecutive 0x47 separated by 188 bytes (one full
 * packet), then verify continuity for several packets. The first 0x47 we
 * find is treated as the start only if a PAT (PID 0) appears within the
 * scan window — guards against false positives in the payload.
 */
export function syncOffset(data: Uint8Array): number {
  const length = data.length;
  let scanwindow = Math.min(PACKET_LENGTH * 5, length - PACKET_LENGTH) + 1;
  let i = 0;
  while (i < scanwindow) {
    let foundPat = false;
    let packetStart = -1;
    let tsPackets = 0;
    for (let j = i; j < length; j += PACKET_LENGTH) {
      if (
        data[j] === SYNC_BYTE &&
        (length - j === PACKET_LENGTH || data[j + PACKET_LENGTH] === SYNC_BYTE)
      ) {
        tsPackets++;
        if (packetStart === -1) {
          packetStart = j;
          // First sync byte found offset; extend the scan window so we
          // don't false-positive on a single isolated 0x47 in payload.
          if (packetStart !== 0) {
            scanwindow =
              Math.min(packetStart + PACKET_LENGTH * 99, data.length - PACKET_LENGTH) + 1;
          }
        }
        if (!foundPat) {
          foundPat = parsePID(data, j) === PID_PAT;
        }
        if (
          foundPat &&
          tsPackets > 1 &&
          ((packetStart === 0 && tsPackets > 2) || j + PACKET_LENGTH > scanwindow)
        ) {
          return packetStart;
        }
      } else if (tsPackets) {
        // Saw sync once but stream broke; bail.
        return -1;
      } else {
        break;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Parsed header for one TS packet starting at `offset` in `data`. The
 * payload (if any) starts at `payloadOffset` and extends to start + 188.
 */
export interface TsPacketHeader {
  pid: number;
  /** payload_unit_start_indicator — true if this packet starts a new PES. */
  payloadUnitStart: boolean;
  /** adaptation_field_control: 0=reserved, 1=payload only, 2=AF only, 3=AF+payload. */
  adaptationFieldControl: number;
  /** continuity_counter — 4-bit modulo, used for integrity checks. */
  continuityCounter: number;
  /** First byte of payload within `data`, or -1 if there is none. */
  payloadOffset: number;
}

/**
 * Parse the 4-byte fixed header (+ optional adaptation field) of one TS
 * packet. Assumes the caller has already verified data[offset] === 0x47.
 */
export function parsePacketHeader(data: Uint8Array, offset: number): TsPacketHeader {
  const byte1 = data[offset + 1]!;
  const byte3 = data[offset + 3]!;
  const pid = ((byte1 & 0x1f) << 8) + data[offset + 2]!;
  const payloadUnitStart = (byte1 & 0x40) !== 0;
  const adaptationFieldControl = (byte3 & 0x30) >> 4;
  const continuityCounter = byte3 & 0x0f;

  let payloadOffset: number;
  if (adaptationFieldControl === 2) {
    // Adaptation field only, no payload.
    payloadOffset = -1;
  } else if (adaptationFieldControl === 3) {
    // Adaptation field followed by payload. Skip the AF (length byte + AF bytes).
    const afLength = data[offset + 4]!;
    payloadOffset = offset + 5 + afLength;
    if (payloadOffset >= offset + PACKET_LENGTH) {
      payloadOffset = -1;
    }
  } else if (adaptationFieldControl === 1) {
    // Payload only.
    payloadOffset = offset + 4;
  } else {
    // adaptationFieldControl === 0 is reserved per spec; treat as no payload.
    payloadOffset = -1;
  }

  return { pid, payloadUnitStart, adaptationFieldControl, continuityCounter, payloadOffset };
}
