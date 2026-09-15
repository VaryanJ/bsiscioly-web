/**
 * The deployed Apps Script web app URL, ending in /exec.
 *
 * Empty means no server is set up: the page offers only the ?demo=1 demo. This URL is not a
 * secret — the page cannot work without it, which is why every rule is enforced by the
 * server rather than here. After changing it, also change the page's connect-src, then run
 * `npm run worker:bundle` and paste the bundle into Cloudflare (docs/CLOUDFLARE-SETUP.md).
 * The tryout server runs on Cloudflare Workers (worker/, docs/CLOUDFLARE-SETUP.md). The Apps Script
 * web app stays deployed as a fallback: to switch back, set this to its /exec URL and publish.
 * Apps Script fallback: https://script.google.com/macros/s/AKfycbxEzbMN7V-OT6sAENpkcc63H2QJBnehm3x2LHLtTuugW1-tNRUqlr3dz58obX0OG2G8UA/exec
 */
export const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxEzbMN7V-OT6sAENpkcc63H2QJBnehm3x2LHLtTuugW1-tNRUqlr3dz58obX0OG2G8UA/exec';
