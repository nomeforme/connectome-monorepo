/**
 * WhatsAppMessageReceptor - Processes WhatsApp message events
 *
 * Handles:
 * - Privacy mode (opt-in/opt-out with `.` prefix)
 * - Deduplication (group messages only first bot emits)
 * - Mention detection via contextInfo.mentionedJid[]
 * - Quote detection via contextInfo.quotedMessage + participant
 * - Bot-message filtering, activation logic, bot-to-bot limiting
 */

import { messageDeduplicator } from '../../message-deduplicator.js';
import { resolveMentionsToNames } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig, WhatsAppMessageEvent } from '../types.js';
import type { WhatsAppCommandEffector } from './whatsapp-command-effector.js';

export interface WhatsAppMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
  commandEffector: WhatsAppCommandEffector;
  updateConfig: (updates: Partial<RuntimeConfig>) => void;
}

/**
 * WhatsAppMessageReceptor - Processes WhatsApp messages into Connectome facets
 */
export class WhatsAppMessageReceptor {
  private bot: BotInstance;
  private state: SharedState;
  private commandEffector: WhatsAppCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;

  // Per-bot deduplication for messages targeted at this bot
  private processedMessages = new Map<string, number>();
  private readonly PROCESSED_TTL = 30000;
  private lastCleanup = Date.now();

  constructor(config: WhatsAppMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.commandEffector = config.commandEffector;
    this.updateConfig = config.updateConfig;
  }

  /**
   * Check if this bot has already processed this message
   */
  private hasProcessed(messageId: string): boolean {
    const now = Date.now();
    if (now - this.lastCleanup > 10000) {
      this.lastCleanup = now;
      const cutoff = now - this.PROCESSED_TTL;
      for (const [id, timestamp] of this.processedMessages) {
        if (timestamp < cutoff) {
          this.processedMessages.delete(id);
        }
      }
    }

    return this.processedMessages.has(messageId);
  }

  /**
   * Mark a message as processed by this bot
   */
  private markProcessed(messageId: string): void {
    this.processedMessages.set(messageId, Date.now());
  }

  /**
   * Handle incoming WhatsApp message
   */
  async handleMessage(event: WhatsAppMessageEvent): Promise<void> {
    const botName = this.bot.config.name;
    const botPhone = this.bot.config.phone;
    const botJid = this.bot.config.jid;

    // Build stream ID
    const streamId = event.groupJid
      ? `whatsapp:group:${event.groupJid}`
      : `whatsapp:dm:${botPhone}:${event.senderJid}`;

    const isGroupMessage = !!event.groupJid;
    const groupPrivacyMode = this.state.runtimeConfig.groupPrivacyMode;

    // Check if this bot was mentioned
    const botMentioned = this.isBotMentioned(event.mentionedJids, botJid);
    // Check if this bot was quoted
    const quotedBotName = this.findQuotedBot(event.quotedMessage);
    const quotedBot = quotedBotName === botName;

    if (event.quotedMessage) {
      console.log(`[WhatsAppMessageReceptor:${botName}] Quote detected - participant: ${event.quotedMessage.participant}, resolved to: ${quotedBotName || 'unknown'}, isMe: ${quotedBot}`);
    }

    // ============================================================
    // STEP 1: Handle privacy mode for group messages
    // ============================================================
    let processedContent = event.content || '';
    let shouldEmitToConnectome = true;

    if (isGroupMessage) {
      const hasDotPrefix = processedContent.startsWith('.');

      if (groupPrivacyMode === 'opt-in') {
        if (!hasDotPrefix && !botMentioned && !quotedBot) {
          shouldEmitToConnectome = false;
          console.log(`[WhatsAppMessageReceptor:${botName}] Opt-in mode: Skipping message (no prefix, not mentioned)`);
        }
        if (hasDotPrefix) {
          processedContent = processedContent.substring(1).trim();
        }
      } else {
        if (hasDotPrefix) {
          console.log(`[WhatsAppMessageReceptor:${botName}] Opt-out mode: Skipping message with '.' prefix`);
          return;
        }
      }
    }

    // Resolve mentions to readable @name format
    const jidToName = new Map<string, string>();
    for (const [jid, name] of this.state.botJidToName) {
      jidToName.set(jid, name);
    }
    const readableContent = resolveMentionsToNames(processedContent, event.mentionedJids, jidToName);

    // Build message ID for deduplication
    const messageId = event.messageId;

    // Check if sender is a bot
    const isSenderBot = this.state.botJidToName.has(event.senderJid);

    // ============================================================
    // STEP 2: Emit to Connectome (dedup + priority emitter logic)
    // ============================================================
    const hasImageAttachments = event.attachments?.some(
      att => att.contentType?.startsWith('image/')
    ) ?? false;

    // Find all targeted bots
    const targetedBotNames: string[] = [];
    if (event.mentionedJids) {
      for (const jid of event.mentionedJids) {
        const name = this.state.botJidToName.get(jid);
        if (name && !targetedBotNames.includes(name)) {
          targetedBotNames.push(name);
        }
      }
    }
    if (event.quotedMessage?.participant) {
      const quotedName = this.state.botJidToName.get(event.quotedMessage.participant);
      if (quotedName && !targetedBotNames.includes(quotedName)) {
        targetedBotNames.push(quotedName);
      }
    }

    // Determine priority emitter for attachment+targeted case
    let priorityEmitter: string | null = null;
    if (hasImageAttachments && targetedBotNames.length > 0) {
      targetedBotNames.sort();
      priorityEmitter = targetedBotNames[0];
      console.log(`[WhatsAppMessageReceptor:${botName}] Message has image + targets: [${targetedBotNames.join(', ')}], priority emitter: ${priorityEmitter}`);
    }

    let skipActivationForPriority = false;

    if (isGroupMessage && shouldEmitToConnectome) {
      if (priorityEmitter) {
        if (botName !== priorityEmitter) {
          shouldEmitToConnectome = false;
          if (targetedBotNames.includes(botName)) {
            skipActivationForPriority = true;
            console.log(`[WhatsAppMessageReceptor:${botName}] Skipping (targeted but not priority emitter, ${priorityEmitter} will handle)`);
          }
        }
      } else {
        const dedupeKey = `emit-${event.senderJid}-${event.timestamp}-${event.content?.substring(0, 50)}`;
        if (!messageDeduplicator.shouldEmit(dedupeKey, botPhone, isGroupMessage)) {
          shouldEmitToConnectome = false;
          console.log(`[WhatsAppMessageReceptor:${botName}] Another bot will emit this message to Connectome`);
        }
      }
    }

    // Don't emit bot messages to Connectome (recorded via agent:speech)
    if (isSenderBot && shouldEmitToConnectome) {
      shouldEmitToConnectome = false;
      console.log(`[WhatsAppMessageReceptor:${botName}] Skipping bot message emission (recorded via agent:speech)`);
    }

    if (shouldEmitToConnectome) {
      try {
        await this.bot.streamManager.getOrCreateStream(
          event.groupJid || event.senderJid || 'unknown',
          {
            conversationType: event.groupJid ? 'group' : 'dm',
            groupJid: event.groupJid,
            groupName: event.groupName,
            contactJid: event.senderJid,
            botPhone
          }
        );

        await this.bot.grpcClient.emitWhatsAppMessage({
          content: readableContent,
          sender: event.sender,
          senderJid: event.senderJid,
          groupJid: event.groupJid,
          groupName: event.groupName,
          botPhone,
          timestamp: event.timestamp,
          attachments: event.attachments,
          mentionedJids: event.mentionedJids,
          quotedMessage: event.quotedMessage,
          messageId: event.messageId
        });

        console.log(`[WhatsAppMessageReceptor:${botName}] Emitted message to Connectome: ${readableContent.substring(0, 50)}...`);
      } catch (error: any) {
        console.error(`[WhatsAppMessageReceptor:${botName}] Error emitting to Connectome:`, error.message);
      }
    }

    // ============================================================
    // STEP 3: Check self-mention
    // ============================================================
    const isSelfMention = event.senderJid === botJid;
    if (isSelfMention) {
      console.log(`[WhatsAppMessageReceptor:${botName}] Ignoring self-mention (sender is this bot)`);
      return;
    }

    // ============================================================
    // STEP 4: Determine if agent should be activated
    // ============================================================
    let shouldActivate = false;
    let activationReason = '';

    if (botMentioned) {
      if (this.hasProcessed(messageId)) {
        console.log(`[WhatsAppMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 20)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'mention';
    } else if (quotedBot) {
      if (this.hasProcessed(messageId)) {
        console.log(`[WhatsAppMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 20)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'quote';
    } else if (!isGroupMessage) {
      if (this.hasProcessed(messageId)) {
        console.log(`[WhatsAppMessageReceptor:${botName}] Already processed DM ${messageId.substring(0, 20)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'dm';
    }

    // Random reply check
    if (!shouldActivate && isGroupMessage) {
      const randomChance = this.state.runtimeConfig.randomReplyChance;
      if (randomChance > 0 && !isSenderBot) {
        const roll = Math.floor(Math.random() * randomChance) + 1;
        const shouldRandomReply = roll === 1;
        console.log(`[WhatsAppMessageReceptor:${botName}] Random roll: ${roll}/${randomChance} (trigger=${shouldRandomReply})`);
        if (shouldRandomReply) {
          shouldActivate = true;
          activationReason = 'random';
        }
      }
    }

    if (!shouldActivate) return;
    if (skipActivationForPriority) return;

    console.log(`[WhatsAppMessageReceptor:${botName}] Activating for message from ${event.sender}: ${readableContent.substring(0, 50)}... (${activationReason})`);

    // Handle "m continue" continuation command
    const contentStripped = readableContent.replace(/^@\S+\s+/, '').trim();
    if (/^m\s+(continue|go|more)\b/i.test(contentStripped)) {
      console.log(`[WhatsAppMessageReceptor:${botName}] Continuation command detected`);
      try {
        await this.bot.grpcClient.activateAgent(streamId, 'continuation', {
          messageContent: '',
          authorName: event.sender,
          streamType: 'whatsapp',
          targetBot: botName,
          continuation: 'true',
        });
      } catch (error: any) {
        console.error(`[WhatsAppMessageReceptor:${botName}] Error sending continuation activation:`, error.message);
      }
      return;
    }

    // Handle ! commands
    const commandText = this.parseCommand(readableContent);
    if (commandText) {
      const response = this.commandEffector.handleCommand(
        commandText,
        this.state.runtimeConfig,
        this.updateConfig,
        (topic, payload) => this.bot.grpcClient.emitEvent(topic, payload)
      );
      if (response) {
        try {
          await this.sendWhatsAppMessage(response, event);
          console.log(`[WhatsAppMessageReceptor:${botName}] Handled command: ${commandText.substring(0, 30)}...`);
        } catch (error: any) {
          console.error(`[WhatsAppMessageReceptor:${botName}] Error sending command response:`, error.message);
        }
        return;
      }
    }

    this.markProcessed(messageId);

    // ============================================================
    // STEP 5: Bot-to-bot limiting and agent activation
    // ============================================================
    if (isSenderBot) {
      const currentCount = this.state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = this.state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[WhatsAppMessageReceptor:${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}), skipping agent`);
        return;
      }

      this.state.botInteractionCounts.set(streamId, currentCount + 1);
      console.log(`[WhatsAppMessageReceptor:${botName}] Bot-to-bot interaction ${currentCount + 1}/${maxBotMentions}`);
    } else {
      if (this.state.botInteractionCounts.has(streamId)) {
        this.state.botInteractionCounts.set(streamId, 0);
        console.log(`[WhatsAppMessageReceptor:${botName}] Human message - reset bot-to-bot counter`);
      }
    }

    // Trigger remote agent activation via gRPC
    try {
      if (!this.bot.grpcClient.isConnected()) {
        console.warn(`[WhatsAppMessageReceptor:${botName}] gRPC client not connected, skipping activation`);
        return;
      }

      await this.bot.streamManager.getOrCreateStream(
        event.groupJid || event.senderJid || 'unknown',
        {
          conversationType: event.groupJid ? 'group' : 'dm',
          groupJid: event.groupJid,
          groupName: event.groupName,
          contactJid: event.senderJid,
          botPhone
        }
      );

      await this.bot.grpcClient.activateAgent(streamId, activationReason, {
        messageContent: readableContent,
        authorName: event.sender,
        streamType: 'whatsapp',
        targetBot: botName
      });
      console.log(`[WhatsAppMessageReceptor:${botName}] Remote activation sent for stream ${streamId}`);
    } catch (error: any) {
      console.error(`[WhatsAppMessageReceptor:${botName}] Error activating agent:`, error.message);
    }
  }

  /**
   * Parse command from message text
   */
  private parseCommand(message: string): string | null {
    if (!message) return null;

    let cleaned = message.trim();

    // Strip leading @mention if present
    if (cleaned.startsWith('@')) {
      const spaceIndex = cleaned.indexOf(' ');
      if (spaceIndex > 0) {
        cleaned = cleaned.substring(spaceIndex + 1).trim();
      } else {
        return null;
      }
    }

    if (!cleaned.startsWith('!')) return null;
    return cleaned;
  }

  /**
   * Check if THIS bot was mentioned
   */
  private isBotMentioned(mentionedJids: string[] | undefined, botJid: string): boolean {
    if (!mentionedJids) return false;
    return mentionedJids.includes(botJid);
  }

  /**
   * Find if quoted message was from one of our bots
   */
  private findQuotedBot(quote: WhatsAppMessageEvent['quotedMessage']): string | undefined {
    if (!quote?.participant) return undefined;
    return this.state.botJidToName.get(quote.participant);
  }

  /**
   * Send a message to WhatsApp (for command responses)
   */
  private async sendWhatsAppMessage(content: string, originalEvent: WhatsAppMessageEvent): Promise<void> {
    const { BaileysSession } = await import('../baileys-session.js');
    // Find the bot's session from the bot instance
    // We need to access the session — it's stored on the shared state bots map
    const botInstance = this.state.bots.get(this.bot.config.phone);
    if (!botInstance) return;

    // Access session through the connection receptor's session reference
    // For command responses, we emit through gRPC and let the speech effector handle it
    // But for immediate command responses, we need direct access
    // The session is not directly on BotInstance — we need to use the global sessions map
    const jid = originalEvent.groupJid || originalEvent.senderJid;
    // Use the gRPC client to emit a speech event that will be picked up by the effector
    // Actually, for commands we want immediate response — emit directly to Connectome
    // and let it flow through normally. But commands need direct send.
    // We'll emit a direct event and handle it in the speech effector.
    await this.bot.grpcClient.emitEvent('whatsapp:commandResponse', {
      content,
      targetJid: jid,
      botPhone: this.bot.config.phone,
      botName: this.bot.config.name
    });
  }
}
