/**
 * WhatsAppTypingReceptor - Handles WhatsApp presence/typing updates
 *
 * Processes typing indicators from Baileys session.
 * These are informational and don't trigger agent activation.
 */

import type { BotInstance } from '../types.js';

export interface WhatsAppTypingReceptorConfig {
  bot: BotInstance;
}

/**
 * WhatsAppTypingReceptor - Processes WhatsApp typing indicators
 */
export class WhatsAppTypingReceptor {
  private bot: BotInstance;

  constructor(config: WhatsAppTypingReceptorConfig) {
    this.bot = config.bot;
  }

  /**
   * Handle presence update from Baileys
   */
  async handlePresence(update: any): Promise<void> {
    // update format: { id: jid, presences: { [jid]: { lastKnownPresence: 'composing' | 'available' | ... } } }
    if (!update?.id || !update?.presences) return;

    const groupJid = update.id.endsWith('@g.us') ? update.id : undefined;

    for (const [senderJid, presence] of Object.entries(update.presences) as [string, any][]) {
      const isTyping = presence.lastKnownPresence === 'composing';

      try {
        await this.bot.grpcClient.emitWhatsAppTyping({
          senderJid,
          groupJid,
          type: presence.lastKnownPresence,
          timestamp: Date.now(),
          botPhone: this.bot.config.phone
        });
      } catch {
        // Typing indicators are non-critical
      }
    }
  }
}
