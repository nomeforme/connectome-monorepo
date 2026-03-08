/**
 * WhatsAppSpeechEffector - Handles server-generated speech and sends to WhatsApp
 *
 * Subscribes to speech facets from the Connectome server
 * and sends them to WhatsApp via Baileys:
 * - Speech facets → WhatsApp messages
 * - Typing indicator before message
 * - Rate limiting for anti-ban
 *
 * Each managed bot delivers only its own speech.
 */

import { cleanSpeechContent, splitMessage, detectAndConvertMentions, getNameToJidCache, rateLimiter } from '../utils/index.js';
import type { BaileysSession } from '../baileys-session.js';
import type { StreamManager, StreamInfo } from '../stream-manager.js';
import type { BotConfig } from '../types.js';

export interface WhatsAppSpeechEffectorConfig {
  botConfig: BotConfig;
  streamManager: StreamManager;
  session: BaileysSession;
  /** Set of bot names managed by this axon */
  managedBotNames: Set<string>;
  maxMessageLength?: number;
}

/**
 * WhatsAppSpeechEffector - Sends server-generated speech to WhatsApp
 */
export class WhatsAppSpeechEffector {
  private botConfig: BotConfig;
  private streamManager: StreamManager;
  private session: BaileysSession;
  private managedBotNames: Set<string>;
  private maxMessageLength?: number;

  constructor(config: WhatsAppSpeechEffectorConfig) {
    this.botConfig = config.botConfig;
    this.streamManager = config.streamManager;
    this.session = config.session;
    this.managedBotNames = config.managedBotNames;
    this.maxMessageLength = config.maxMessageLength;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.botConfig.name;
  }

  /**
   * Set up subscriptions to server facets
   */
  setup(): void {
    this.setupSpeechHandler();
    console.log(`[WhatsAppSpeechEffector:${this.botConfig.name}] Handlers registered`);
  }

  /**
   * Set up speech handler
   */
  private setupSpeechHandler(): void {
    this.streamManager.onSpeech(async (facet, streamInfo) => {
      await this.handleSpeech(facet, streamInfo);
    });
  }

  /**
   * Handle speech facet from server
   */
  private async handleSpeech(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;

    // Determine speaker identity
    const speakerName = facet.agentName || facet.agentId || '';

    // Only deliver speech that matches THIS bot's name
    if (speakerName !== botName && facet.agentName !== botName) {
      return;
    }

    const targetJid = streamInfo.groupJid || streamInfo.contactJid;
    if (!targetJid) {
      console.warn(`[WhatsAppSpeechEffector:${botName}] No target JID for stream ${streamInfo.streamId}`);
      return;
    }

    console.log(`[WhatsAppSpeechEffector:${botName}] Sending message to ${streamInfo.groupName || streamInfo.contactJid || streamInfo.streamId}`);

    try {
      // Clean speech content
      const cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent) return;

      // Detect @mentions and convert to WhatsApp format
      const { content: contentWithMentions, mentions } = detectAndConvertMentions(
        cleanedContent,
        getNameToJidCache()
      );

      // Split if too long
      const chunks = splitMessage(contentWithMentions, this.maxMessageLength);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Rate limiting
        const delay = await rateLimiter.waitForSlot(targetJid);
        if (delay > 100) {
          console.log(`[WhatsAppSpeechEffector:${botName}] Rate limiter delay: ${delay}ms`);
        }

        // Send typing indicator before message
        try {
          await this.session.sendPresenceUpdate('composing', targetJid);
          // Brief typing duration proportional to message length (50-2000ms)
          const typingDuration = Math.min(2000, Math.max(50, chunk.length * 3));
          await new Promise(resolve => setTimeout(resolve, typingDuration));
          await this.session.sendPresenceUpdate('paused', targetJid);
        } catch {
          // Typing indicators are non-critical
        }

        // Send message
        await this.session.sendMessage(targetJid, {
          text: chunk,
          mentions: i === 0 ? mentions : undefined
        });
      }

      console.log(`[WhatsAppSpeechEffector:${botName}] Sent ${chunks.length} chunk(s)`);
    } catch (error: any) {
      console.error(`[WhatsAppSpeechEffector:${botName}] Error sending message:`, error.message);
    }
  }

  /**
   * Send a direct message (for command responses, bypassing speech pipeline)
   */
  async sendDirect(jid: string, content: string): Promise<void> {
    const delay = await rateLimiter.waitForSlot(jid);
    if (delay > 100) {
      console.log(`[WhatsAppSpeechEffector:${this.botConfig.name}] Rate limiter delay: ${delay}ms`);
    }

    const chunks = splitMessage(content, this.maxMessageLength);
    for (const chunk of chunks) {
      await this.session.sendMessage(jid, { text: chunk });
    }
  }
}
