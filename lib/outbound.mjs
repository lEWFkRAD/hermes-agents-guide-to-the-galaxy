function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const OUTBOUND_TIMEOUTS = Object.freeze({
  chat: positiveTimeout(process.env.DIARY_CHAT_TIMEOUT_MS, 120000),
  stream: positiveTimeout(process.env.DIARY_STREAM_TIMEOUT_MS, 300000),
  adapter: positiveTimeout(process.env.DIARY_ADAPTER_TIMEOUT_MS, 300000),
  warm: positiveTimeout(process.env.DIARY_WARM_TIMEOUT_MS, 15000)
});

export async function fetchWithTimeout(url, options = {}, timeoutMs, label = "upstream") {
  const timeout = positiveTimeout(timeoutMs, 120000);
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeout} ms`, { cause: error });
    }
    throw error;
  }
}
