/**
 * The deployed Apps Script web app URL, ending in /exec.
 *
 * Empty means no server is set up: the page offers only the ?demo=1 demo. This URL is not a
 * secret — the page cannot work without it, which is why every rule is enforced by the
 * server rather than here. After changing it, run `npm run web:publish` and push the mirror.
 * Updating the server keeps this URL (Manage deployments -> New version); a new deployment
 * would change it.
 */
export const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxEzbMN7V-OT6sAENpkcc63H2QJBnehm3x2LHLtTuugW1-tNRUqlr3dz58obX0OG2G8UA/exec';
