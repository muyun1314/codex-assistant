// Simple IP-based token-bucket rate limiter with periodic cleanup.

const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "120", 10);
const rateBuckets = new Map();

export function checkRateLimit(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

export function startRateLimitCleanup() {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.start > RATE_LIMIT_WINDOW * 2) rateBuckets.delete(key);
    }
  }, RATE_LIMIT_WINDOW).unref();
}
