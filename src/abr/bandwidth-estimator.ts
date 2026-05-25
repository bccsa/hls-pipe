/*
 * hls-pipe — EWMA Bandwidth Estimator
 *
 * Direct port from hls.js src/utils/ewma-bandwidth-estimator.ts.
 * Modifications from upstream:
 *   - converted from `export default class` to a named `export class`
 *   - import path updated for local EWMA
 *   - removed empty destroy() method (no resources to release in this port)
 * Algorithm and behavior are otherwise byte-for-byte identical.
 *
 * Upstream:
 *   https://github.com/video-dev/hls.js/blob/master/src/utils/ewma-bandwidth-estimator.ts
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
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ---------------------------------------------------------------------------
 *
 * EWMA Bandwidth Estimator
 *  - heavily inspired from shaka-player
 * Tracks bandwidth samples and estimates available bandwidth.
 * Based on the minimum of two exponentially-weighted moving averages with
 * different half-lives.
 */

import { EWMA } from './ewma.js';

export class EwmaBandWidthEstimator {
  private defaultEstimate_: number;
  private minWeight_: number;
  private minDelayMs_: number;
  private slow_: EWMA;
  private fast_: EWMA;
  private defaultTTFB_: number;
  private ttfb_: EWMA;

  constructor(slow: number, fast: number, defaultEstimate: number, defaultTTFB: number = 100) {
    this.defaultEstimate_ = defaultEstimate;
    this.minWeight_ = 0.001;
    this.minDelayMs_ = 50;
    this.slow_ = new EWMA(slow);
    this.fast_ = new EWMA(fast);
    this.defaultTTFB_ = defaultTTFB;
    this.ttfb_ = new EWMA(slow);
  }

  update(slow: number, fast: number): void {
    const { slow_, fast_, ttfb_ } = this;
    if (slow_.halfLife !== slow) {
      this.slow_ = new EWMA(slow, slow_.getEstimate(), slow_.getTotalWeight());
    }
    if (fast_.halfLife !== fast) {
      this.fast_ = new EWMA(fast, fast_.getEstimate(), fast_.getTotalWeight());
    }
    if (ttfb_.halfLife !== slow) {
      this.ttfb_ = new EWMA(slow, ttfb_.getEstimate(), ttfb_.getTotalWeight());
    }
  }

  sample(durationMs: number, numBytes: number): void {
    durationMs = Math.max(durationMs, this.minDelayMs_);
    const numBits = 8 * numBytes;
    // weight is duration in seconds
    const durationS = durationMs / 1000;
    // value is bandwidth in bits/s
    const bandwidthInBps = numBits / durationS;
    this.fast_.sample(durationS, bandwidthInBps);
    this.slow_.sample(durationS, bandwidthInBps);
  }

  sampleTTFB(ttfb: number): void {
    // weight is frequency curve applied to TTFB in seconds
    // (longer times have less weight with expected input under 1 second)
    const seconds = ttfb / 1000;
    const weight = Math.sqrt(2) * Math.exp(-Math.pow(seconds, 2) / 2);
    this.ttfb_.sample(weight, Math.max(ttfb, 5));
  }

  canEstimate(): boolean {
    return this.fast_.getTotalWeight() >= this.minWeight_;
  }

  getEstimate(): number {
    if (this.canEstimate()) {
      // Take the minimum of these two estimates.  This should have the effect of
      // adapting down quickly, but up more slowly.
      return Math.min(this.fast_.getEstimate(), this.slow_.getEstimate());
    } else {
      return this.defaultEstimate_;
    }
  }

  getEstimateTTFB(): number {
    if (this.ttfb_.getTotalWeight() >= this.minWeight_) {
      return this.ttfb_.getEstimate();
    } else {
      return this.defaultTTFB_;
    }
  }

  get defaultEstimate(): number {
    return this.defaultEstimate_;
  }
}
