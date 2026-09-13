/**
 * The connection from the student page to the deployed Apps Script web app.
 *
 * It speaks the same contract as the in-page stand-in (api-contract.mjs), so the page
 * cannot tell which one it is talking to. That is the point: everything tested against
 * the stand-in is testing the code path Tuesday will use.
 *
 * Two Apps Script facts shape this file:
 * - Requests are sent as text/plain. A JSON content type makes the browser send a CORS
 *   preflight first, and Apps Script web apps cannot answer one.
 * - Apps Script answers a POST with a redirect to where the result is waiting. Following it
 *   is what fetch does by default; the script has already run by then.
 */

// Apps Script can take well over 10 seconds to answer when a whole room is using it at once.
// Giving up too early only adds a retry to the load.
const DEFAULT_TIMEOUT_MS = 30_000;

function failure(message, props = {}) {
  return Object.assign(new Error(message), props);
}

export function createHttpEndpoint({ url, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!url) throw new Error('createHttpEndpoint needs the deployed web app URL (it ends in /exec).');
  if (typeof fetchImpl !== 'function') throw new Error('createHttpEndpoint needs fetch.');

  async function call(action, key, payload) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, [key]: payload }),
        redirect: 'follow',
        signal: controller?.signal
      });
    } catch (error) {
      // No response at all: dropped Wi-Fi, a timeout, a captive portal. Worth retrying.
      throw failure(`Could not reach the test server (${error?.name === 'AbortError' ? 'timed out' : error?.message ?? 'network error'})`, { retryable: true });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) throw failure(`Test server answered HTTP ${response.status}`, { status: response.status });

    try {
      return await response.json();
    } catch {
      // Apps Script returns an HTML page, not JSON, when a deployment is misconfigured or a
      // quota is hit. Retrying covers the transient case; the payload is saved either way.
      throw failure('Test server sent something other than JSON', { retryable: true });
    }
  }

  const serverError = (body) => body && body.ok === false && body.reason === 'server-error';

  return {
    async startAttempt(request) {
      const body = await call('start', 'start', request);
      if (serverError(body)) throw failure('The test server hit an error starting the test', { retryable: true });
      return body; // a refusal ({ ok: false, reason }) is an answer, not an error
    },

    /** Resolves once the server has kept the answers; throws otherwise, so the queue retries. */
    async submitAttempt(payload) {
      const body = await call('submit', 'submission', payload);
      if (body && body.ok) return body;
      const reason = body?.reason || body?.outcome || 'rejected';
      throw failure(reason, { retryable: reason === 'server-error' });
    },

    async getImages(request) {
      const body = await call('images', 'images', request);
      if (serverError(body)) throw failure('The test server hit an error loading images', { retryable: true });
      return body;
    }
  };
}
