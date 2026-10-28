import { fail } from "./common.mjs";

export const MAX_DATA_FRAME_BYTES = 64 * 1024;
export const MAX_BUFFERED_BYTES = 256 * 1024;

export function validateDataFrame(frame) {
  if (!(frame instanceof Uint8Array)) fail("invalid_message");
  if (frame.byteLength > MAX_DATA_FRAME_BYTES) fail("message_too_large");
  return frame;
}

export function validateBufferedAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) fail("invalid_message");
  if (amount > MAX_BUFFERED_BYTES) fail("backpressure_limit");
  return amount;
}
