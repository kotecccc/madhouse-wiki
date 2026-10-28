import { Duplex } from "node:stream";
import {
  MAX_BUFFERED_BYTES,
  validateBufferedAmount,
  validateDataFrame,
} from "./protocol-v1/data-channel.mjs";

function transportError(code) {
  return Object.assign(new Error(code), { code });
}

export class WebSocketDuplex extends Duplex {
  constructor(socket) {
    if (
      !socket ||
      typeof socket.on !== "function" ||
      typeof socket.send !== "function" ||
      typeof socket.close !== "function" ||
      typeof socket.pause !== "function" ||
      typeof socket.resume !== "function"
    )
      throw new TypeError("invalid_data_websocket");
    super({
      allowHalfOpen: false,
      readableHighWaterMark: MAX_BUFFERED_BYTES,
      writableHighWaterMark: MAX_BUFFERED_BYTES,
    });
    this.socket = socket;
    this.socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.destroy(transportError("invalid_data_channel_frame"));
        return;
      }
      try {
        validateDataFrame(data);
      } catch {
        this.destroy(transportError("data_frame_too_large"));
        return;
      }
      if (!this.push(data)) this.socket.pause();
    });
    this.socket.once("close", () => {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
      if (!this.readableEnded && !this.destroyed) this.push(null);
    });
    this.socket.once("error", () => {
      if (!this.destroyed) this.destroy(transportError("data_channel_closed"));
    });
  }

  _read() {
    if (this.socket.readyState === 1) this.socket.resume();
  }

  _write(chunk, _encoding, callback) {
    try {
      validateDataFrame(chunk);
      const queued = validateBufferedAmount(this.socket.bufferedAmount);
      if (queued + chunk.byteLength > MAX_BUFFERED_BYTES)
        throw transportError("backpressure_limit");
      if (this.socket.readyState !== 1)
        throw transportError("data_channel_closed");
      this.socket.send(chunk, { binary: true, compress: false }, (error) => {
        callback(error || undefined);
      });
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    if (this.socket.readyState === 1) this.socket.close(1000, "stream_ended");
    callback();
  }

  _destroy(error, callback) {
    if (this.socket.readyState === 1) {
      this.socket.close(error ? 1011 : 1000, error ? "stream_error" : "closed");
      this.closeTimer = setTimeout(() => this.socket.terminate?.(), 1000);
      this.closeTimer.unref?.();
    } else if (this.socket.readyState === 0) {
      this.socket.terminate?.();
    }
    callback(error);
  }
}
