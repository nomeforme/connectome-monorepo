/**
 * WhatsAppReceiptReceptor - Handles WhatsApp read/delivery receipts
 *
 * Processes receipts from Baileys session.
 * These are informational and don't trigger agent activation.
 */

import type { BotInstance } from '../types.js';

export interface WhatsAppReceiptReceptorConfig {
  bot: BotInstance;
}

/**
 * WhatsAppReceiptReceptor - Processes WhatsApp receipts
 */
export class WhatsAppReceiptReceptor {
  private bot: BotInstance;

  constructor(config: WhatsAppReceiptReceptorConfig) {
    this.bot = config.bot;
  }

  /**
   * Handle receipt updates from Baileys
   */
  async handleReceipts(updates: any[]): Promise<void> {
    const botName = this.bot.config.name;

    for (const update of updates) {
      const receipt = update.receipt;
      if (!receipt) continue;

      const type = receipt.readTimestamp ? 'read' : 'delivered';

      try {
        await this.bot.grpcClient.emitWhatsAppReceipt({
          type,
          senderJid: update.key.remoteJid || '',
          timestamp: receipt.readTimestamp || receipt.receiptTimestamp || Date.now(),
          botPhone: this.bot.config.phone
        });
      } catch (error: any) {
        // Receipts are non-critical
        console.warn(`[WhatsAppReceiptReceptor:${botName}] Failed to emit receipt:`, error.message);
      }
    }
  }
}
