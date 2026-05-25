/*
 * hls-pipe — variant selection
 *
 * Phase 1: static selection only. Phase 2 will replace this with an ABR
 * controller modeled on hls.js src/controller/abr-controller.ts, where
 * `pickVariant` becomes a dynamic decision driven by an EWMA bandwidth
 * estimator and the virtual buffer state.
 *
 * The current interface intentionally takes the same inputs the ABR will
 * need later (variants + an opaque hint) so the call site doesn't change.
 */

import type { Variant } from '../types.js';

export type QualityHint =
  | { kind: 'highest' }
  | { kind: 'lowest' }
  | { kind: 'index'; index: number }
  | { kind: 'maxBitrate'; bitrate: number }; // pick highest variant <= bitrate

export class NoVariantsError extends Error {
  constructor() {
    super('master playlist contains no variants');
    this.name = 'NoVariantsError';
  }
}

export function pickVariant(variants: Variant[], hint: QualityHint): Variant {
  if (variants.length === 0) throw new NoVariantsError();

  // Stable bitrate-ascending copy.
  const sorted = [...variants].sort((a, b) => a.bitrate - b.bitrate);

  switch (hint.kind) {
    case 'lowest':
      return sorted[0]!;
    case 'highest':
      return sorted[sorted.length - 1]!;
    case 'index': {
      const idx = clamp(hint.index, 0, sorted.length - 1);
      return sorted[idx]!;
    }
    case 'maxBitrate': {
      let chosen = sorted[0]!;
      for (const v of sorted) {
        if (v.bitrate <= hint.bitrate) chosen = v;
        else break;
      }
      return chosen;
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
