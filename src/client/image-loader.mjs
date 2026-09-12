/**
 * Loads a test's images after the attempt starts.
 *
 * Every image is checked against the byte count and SHA-256 recorded when the test was
 * verified. A mismatch is shown as a failure, never rendered: a wrong or corrupted image
 * silently beside a question turns right answers into zeros for everyone (R3-3).
 * Images are kept in memory only, never written to device storage.
 */

import { planImageBatches } from '../policy/image-policy.mjs';
import { isRetryable, backoffDelayMs } from './submission-queue.mjs';
import { base64ToBytes, sha256Hex } from './bytes.mjs';

export const IMAGE_STATES = { PENDING: 'pending', LOADED: 'loaded', FAILED: 'failed' };

const defaultToUrl = (bytes, mimeType) => URL.createObjectURL(new Blob([bytes], { type: mimeType }));

export function createImageLoader({
  endpoint, identityKey, testId, images = [],
  toUrl = defaultToUrl, hash = sha256Hex,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  options = {}
}) {
  const settings = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000, maxBatchBytes: 1_000_000, maxPerBatch: 8, ...options };
  const meta = new Map(images.map((image) => [image.id, image]));
  const states = new Map(images.map((image) => [image.id, { state: IMAGE_STATES.PENDING }]));
  const listeners = new Set();

  const set = (id, value) => {
    states.set(id, value);
    for (const listener of listeners) listener(id, value);
  };

  async function accept(entry) {
    const expected = meta.get(entry.id);
    if (!expected || entry.missing) return set(entry.id, { state: IMAGE_STATES.FAILED, reason: 'missing' });
    const bytes = base64ToBytes(entry.dataBase64);
    if (bytes.length !== expected.bytes || (await hash(bytes)) !== expected.sha256) {
      return set(entry.id, { state: IMAGE_STATES.FAILED, reason: 'integrity' });
    }
    set(entry.id, { state: IMAGE_STATES.LOADED, url: toUrl(bytes, entry.mimeType) });
  }

  async function loadBatch(ids) {
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      try {
        const response = await endpoint.getImages({ identityKey, testId, imageIds: ids });
        if (!response.ok) {
          for (const id of ids) set(id, { state: IMAGE_STATES.FAILED, reason: response.reason });
          return;
        }
        const returned = new Set();
        for (const entry of response.images) {
          returned.add(entry.id);
          await accept(entry);
        }
        for (const id of ids) if (!returned.has(id)) set(id, { state: IMAGE_STATES.FAILED, reason: 'missing' });
        return;
      } catch (error) {
        if (!isRetryable(error) || attempt === settings.maxAttempts) {
          for (const id of ids) set(id, { state: IMAGE_STATES.FAILED, reason: 'network' });
          return;
        }
        await wait(backoffDelayMs(attempt, settings, random));
      }
    }
  }

  return {
    async loadAll() {
      // Sequential on purpose: one request per student at a time keeps 30 phones from
      // exhausting the server's concurrent executions.
      for (const batch of planImageBatches(images, settings)) await loadBatch(batch);
      return this.summary();
    },
    async retry(id) {
      set(id, { state: IMAGE_STATES.PENDING });
      await loadBatch([id]);
      return states.get(id);
    },
    status: (id) => states.get(id),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    summary() {
      const counts = { pending: 0, loaded: 0, failed: 0 };
      for (const { state } of states.values()) counts[state] += 1;
      return counts;
    }
  };
}
