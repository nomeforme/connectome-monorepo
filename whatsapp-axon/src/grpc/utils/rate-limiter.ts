/**
 * Rate limiter for WhatsApp message sending
 *
 * Anti-ban delays with global and per-JID rate limiting.
 * Adds random jitter to appear more human-like.
 */

/**
 * Rate limiter configuration
 */
interface RateLimiterConfig {
  /** Minimum delay between any two sends (ms) */
  globalDelayMs?: number;
  /** Minimum delay between sends to the same JID (ms) */
  perJidDelayMs?: number;
  /** Max random jitter added to delays (ms) */
  jitterMs?: number;
}

/**
 * RateLimiter — anti-ban delay queue for WhatsApp sends
 */
export class RateLimiter {
  private globalDelayMs: number;
  private perJidDelayMs: number;
  private jitterMs: number;
  private lastGlobalSend = 0;
  private lastJidSend = new Map<string, number>();

  constructor(config: RateLimiterConfig = {}) {
    this.globalDelayMs = config.globalDelayMs ?? 1500;
    this.perJidDelayMs = config.perJidDelayMs ?? 3000;
    this.jitterMs = config.jitterMs ?? 500;
  }

  /**
   * Wait until it's safe to send a message to the given JID.
   * Returns the actual delay applied (for logging).
   */
  async waitForSlot(jid: string): Promise<number> {
    const now = Date.now();

    // Calculate required delay
    const globalElapsed = now - this.lastGlobalSend;
    const globalWait = Math.max(0, this.globalDelayMs - globalElapsed);

    const lastJid = this.lastJidSend.get(jid) || 0;
    const jidElapsed = now - lastJid;
    const jidWait = Math.max(0, this.perJidDelayMs - jidElapsed);

    // Take the larger delay
    const baseDelay = Math.max(globalWait, jidWait);

    // Add random jitter
    const jitter = Math.floor(Math.random() * this.jitterMs);
    const totalDelay = baseDelay + jitter;

    if (totalDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }

    // Record send time
    const sendTime = Date.now();
    this.lastGlobalSend = sendTime;
    this.lastJidSend.set(jid, sendTime);

    // Cleanup old JID entries (older than 60s)
    if (this.lastJidSend.size > 100) {
      const cutoff = sendTime - 60000;
      for (const [key, time] of this.lastJidSend) {
        if (time < cutoff) {
          this.lastJidSend.delete(key);
        }
      }
    }

    return totalDelay;
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();
