import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an HMAC-SHA256 webhook signature in constant time.
 *
 * Real payment/messaging providers sign each webhook with a shared secret so
 * you can prove the request truly came from them. Two things matter:
 *
 *  1. The comparison MUST be timing-safe. A naive `===` on the hex digests
 *     leaks, through response timing, how many leading bytes matched — enough
 *     to forge a signature byte by byte. We use {@link timingSafeEqual}.
 *  2. `timingSafeEqual` throws if the buffers differ in length, so we guard
 *     that first and return `false` rather than letting it throw.
 */
export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/**
 * Helper for tests and local tooling: produce the signature a provider would
 * send for a given payload. You would never call this in request-handling
 * code — the provider holds the secret and signs on their side.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
