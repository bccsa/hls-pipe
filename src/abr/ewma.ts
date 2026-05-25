/*
 * hls-pipe — Exponential Weighted Moving Average
 *
 * Direct port from hls.js src/utils/ewma.ts.
 * Modifications from upstream:
 *   - converted from `export default class` to a named `export class`
 *   - hls.js comment style preserved
 * Algorithm and behavior are byte-for-byte identical.
 *
 * Upstream:
 *   https://github.com/video-dev/hls.js/blob/master/src/utils/ewma.ts
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
 * compute an Exponential Weighted moving average
 *  - https://en.wikipedia.org/wiki/Moving_average#Exponential_moving_average
 *  - heavily inspired from shaka-player
 */

export class EWMA {
  public readonly halfLife: number;
  private alpha_: number;
  private estimate_: number;
  private totalWeight_: number;

  //  About half of the estimated value will be from the last |halfLife| samples by weight.
  constructor(halfLife: number, estimate: number = 0, weight: number = 0) {
    this.halfLife = halfLife;
    // Larger values of alpha expire historical data more slowly.
    this.alpha_ = halfLife ? Math.exp(Math.log(0.5) / halfLife) : 0;
    this.estimate_ = estimate;
    this.totalWeight_ = weight;
  }

  sample(weight: number, value: number): void {
    const adjAlpha = Math.pow(this.alpha_, weight);
    this.estimate_ = value * (1 - adjAlpha) + adjAlpha * this.estimate_;
    this.totalWeight_ += weight;
  }

  getTotalWeight(): number {
    return this.totalWeight_;
  }

  getEstimate(): number {
    if (this.alpha_) {
      const zeroFactor = 1 - Math.pow(this.alpha_, this.totalWeight_);
      if (zeroFactor) {
        return this.estimate_ / zeroFactor;
      }
    }
    return this.estimate_;
  }
}
