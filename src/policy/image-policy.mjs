/**
 * Who may receive a test image, and in what batches.
 *
 * Images are protected test content (final-plan.md §1). They are released only to a
 * student with a started attempt on the test the image belongs to, and only until that
 * attempt ends. So no student can preview another test's images, including a test in a
 * different block, without spending that block on it.
 */

import { computeDeadlineMs, grantedExtensionMinutes } from './attempt-policy.mjs';

export const IMAGE_REFUSAL = {
  NO_ATTEMPT: 'no-attempt',
  EMPTY_REQUEST: 'empty-request',
  TOO_MANY: 'too-many-images',
  NOT_IN_TEST: 'image-not-in-test',
  ATTEMPT_ENDED: 'attempt-ended'
};

export const MAX_IMAGES_PER_REQUEST = 12;

export function authorizeImageFetch({ window, config, attempt, test, imageIds, nowMs }) {
  const refuse = (reason) => ({ authorized: false, reason });
  if (!attempt || attempt.firstDeliveryMs === undefined) return refuse(IMAGE_REFUSAL.NO_ATTEMPT);
  if (!Array.isArray(imageIds) || imageIds.length === 0) return refuse(IMAGE_REFUSAL.EMPTY_REQUEST);
  if (imageIds.length > MAX_IMAGES_PER_REQUEST) return refuse(IMAGE_REFUSAL.TOO_MANY);

  const known = new Set((test?.images ?? []).map((image) => image.id));
  if (imageIds.some((id) => !known.has(id))) return refuse(IMAGE_REFUSAL.NOT_IN_TEST);

  const deadlineMs = computeDeadlineMs({
    firstDeliveryMs: attempt.firstDeliveryMs,
    attemptMinutes: config.attemptMinutes,
    extensionMinutesTotal: grantedExtensionMinutes(attempt),
    hardCloseMs: window.hardCloseMs
  });
  if (nowMs > deadlineMs + (config.graceSeconds ?? 0) * 1000) return refuse(IMAGE_REFUSAL.ATTEMPT_ENDED);
  return { authorized: true, deadlineMs };
}

/**
 * Group images into request batches in display order.
 *
 * Fewer, bounded requests matter on Tuesday: Apps Script runs a limited number of
 * executions at once, and 30 phones each firing one request per image would queue and
 * fail. An image larger than the byte budget travels alone rather than being refused.
 */
export function planImageBatches(images, { maxBatchBytes = 1_000_000, maxPerBatch = 8 } = {}) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const image of images) {
    const full = current.length >= maxPerBatch || (current.length > 0 && currentBytes + image.bytes > maxBatchBytes);
    if (full) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(image.id);
    currentBytes += image.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
