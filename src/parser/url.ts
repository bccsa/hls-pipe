/*
 * hls-pipe — URL resolution helper
 *
 * HLS playlists contain relative URIs that need resolution against the
 * playlist's own URL. WHATWG URL handles this correctly including for
 * the redirect-modified base URL case.
 */

export function resolveUrl(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}
