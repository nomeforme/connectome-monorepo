/**
 * WhatsAppConnectionReceptor - Manages Baileys session lifecycle per bot
 *
 * Routes Baileys events to appropriate receptors:
 * - messages.upsert → message receptor
 * - messages.update → edit handler
 * - messages.delete → delete handler
 * - message-receipt.update → receipt handler
 * - presence.update → typing handler
 *
 * Downloads attachments via downloadMediaMessage(), compresses with Sharp.
 */

import sharp from 'sharp';
import type { BaileysSession } from '../baileys-session.js';
import type { WhatsAppMessageEvent, WhatsAppAttachment, WhatsAppQuote } from '../types.js';

// Image compression settings
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_JPEG_QUALITY = 80;
const IMAGE_MAX_BYTES = 3_500_000;

export interface WhatsAppConnectionReceptorConfig {
  session: BaileysSession;
  botPhone: string;
  botJid: string;
  onMessage: (event: WhatsAppMessageEvent) => Promise<void>;
  onEdit?: (event: { content: string; sender: string; senderJid: string; groupJid?: string; groupName?: string; botPhone: string; messageId: string; editedTimestamp: number }) => Promise<void>;
  onDelete?: (event: { senderJid: string; groupJid?: string; botPhone: string; messageId: string }) => Promise<void>;
  onReceipt?: (updates: any[]) => Promise<void>;
  onTyping?: (update: any) => Promise<void>;
}

/**
 * WhatsAppConnectionReceptor - Handles Baileys event routing
 */
export class WhatsAppConnectionReceptor {
  private session: BaileysSession;
  private botPhone: string;
  private botJid: string;
  private onMessage: (event: WhatsAppMessageEvent) => Promise<void>;
  private onEdit?: WhatsAppConnectionReceptorConfig['onEdit'];
  private onDelete?: WhatsAppConnectionReceptorConfig['onDelete'];
  private onReceipt?: WhatsAppConnectionReceptorConfig['onReceipt'];
  private onTyping?: WhatsAppConnectionReceptorConfig['onTyping'];

  constructor(config: WhatsAppConnectionReceptorConfig) {
    this.session = config.session;
    this.botPhone = config.botPhone;
    this.botJid = config.botJid;
    this.onMessage = config.onMessage;
    this.onEdit = config.onEdit;
    this.onDelete = config.onDelete;
    this.onReceipt = config.onReceipt;
    this.onTyping = config.onTyping;
  }

  /**
   * Wire up Baileys session events
   */
  setup(): void {
    // New messages
    this.session.on('messages.upsert', async (messages: any[], type: string) => {
      if (type !== 'notify') return; // Only process new incoming messages

      for (const msg of messages) {
        try {
          await this.handleMessage(msg);
        } catch (error: any) {
          console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Error handling message:`, error.message);
        }
      }
    });

    // Message updates (edits)
    this.session.on('messages.update', async (updates: any[]) => {
      if (!this.onEdit) return;

      for (const update of updates) {
        if (update.update?.message) {
          try {
            await this.handleEdit(update);
          } catch (error: any) {
            console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Error handling edit:`, error.message);
          }
        }
      }
    });

    // Message deletions
    this.session.on('messages.delete', async (item: any) => {
      if (!this.onDelete) return;

      try {
        await this.handleDelete(item);
      } catch (error: any) {
        console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Error handling delete:`, error.message);
      }
    });

    // Read/delivery receipts
    this.session.on('message-receipt.update', async (updates: any[]) => {
      if (this.onReceipt) {
        try {
          await this.onReceipt(updates);
        } catch (error: any) {
          console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Error handling receipt:`, error.message);
        }
      }
    });

    // Presence updates (typing)
    this.session.on('presence.update', async (update: any) => {
      if (this.onTyping) {
        try {
          await this.onTyping(update);
        } catch (error: any) {
          // Typing indicators are non-critical
        }
      }
    });

    console.log(`[WhatsAppConnectionReceptor:${this.botPhone}] Event handlers wired`);
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(msg: any): Promise<void> {
    // Skip status updates
    if (msg.key.remoteJid === 'status@broadcast') return;

    // Extract message content from various message types
    const content = this.extractContent(msg);
    const senderJid = msg.key.participant || msg.key.remoteJid!;
    const isGroup = msg.key.remoteJid?.endsWith('@g.us') ?? false;
    const groupJid = isGroup ? msg.key.remoteJid! : undefined;

    // Get sender name
    const sender = msg.pushName || senderJid.replace(/@s\.whatsapp\.net$/, '');

    // Get group name if applicable
    let groupName: string | undefined;
    if (groupJid) {
      const meta = await this.session.groupMetadata(groupJid);
      groupName = meta?.subject;
    }

    // Extract mentions
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo
      || msg.message?.documentMessage?.contextInfo;
    const mentionedJids = contextInfo?.mentionedJid || [];

    // Extract quote
    const quotedMessage = this.parseQuote(contextInfo);

    // Process attachments
    const attachments = await this.parseAttachments(msg);

    const event: WhatsAppMessageEvent = {
      content: content || '',
      sender,
      senderJid,
      groupJid,
      groupName,
      botPhone: this.botPhone,
      timestamp: msg.messageTimestamp ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.low) * 1000 : Date.now(),
      attachments,
      mentionedJids: mentionedJids.length > 0 ? mentionedJids : undefined,
      quotedMessage,
      messageId: msg.key.id!
    };

    await this.onMessage(event);
  }

  /**
   * Handle message edit
   */
  private async handleEdit(update: any): Promise<void> {
    if (!this.onEdit) return;

    const key = update.key;
    const newMessage = update.update?.message;
    const content = newMessage?.conversation || newMessage?.extendedTextMessage?.text || '';
    const senderJid = key.participant || key.remoteJid!;
    const isGroup = key.remoteJid?.endsWith('@g.us') ?? false;
    const groupJid = isGroup ? key.remoteJid! : undefined;

    let groupName: string | undefined;
    if (groupJid) {
      const meta = await this.session.groupMetadata(groupJid);
      groupName = meta?.subject;
    }

    await this.onEdit({
      content,
      sender: senderJid.replace(/@s\.whatsapp\.net$/, ''),
      senderJid,
      groupJid,
      groupName,
      botPhone: this.botPhone,
      messageId: key.id!,
      editedTimestamp: Date.now()
    });
  }

  /**
   * Handle message deletion
   */
  private async handleDelete(item: any): Promise<void> {
    if (!this.onDelete) return;

    // Handle both single and bulk deletions
    const keys = item.keys || (item.key ? [item.key] : []);

    for (const key of keys) {
      const senderJid = key.participant || key.remoteJid!;
      const isGroup = key.remoteJid?.endsWith('@g.us') ?? false;
      const groupJid = isGroup ? key.remoteJid! : undefined;

      await this.onDelete({
        senderJid,
        groupJid,
        botPhone: this.botPhone,
        messageId: key.id!
      });
    }
  }

  /**
   * Extract text content from message
   */
  private extractContent(msg: any): string {
    const m = msg.message;
    if (!m) return '';

    // Regular text
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

    // Media captions
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;

    return '';
  }

  /**
   * Parse quote from context info
   */
  private parseQuote(contextInfo: any): WhatsAppQuote | undefined {
    if (!contextInfo?.quotedMessage) return undefined;

    const quotedText = contextInfo.quotedMessage.conversation
      || contextInfo.quotedMessage.extendedTextMessage?.text
      || contextInfo.quotedMessage.imageMessage?.caption
      || '';

    return {
      messageId: contextInfo.stanzaId,
      participant: contextInfo.participant,
      text: quotedText
    };
  }

  /**
   * Parse and process attachments from message
   */
  private async parseAttachments(msg: any): Promise<WhatsAppAttachment[] | undefined> {
    const m = msg.message;
    if (!m) return undefined;

    const attachments: WhatsAppAttachment[] = [];

    // Check for image
    if (m.imageMessage) {
      const data = await this.downloadAndCompress(msg);
      attachments.push({
        contentType: data ? 'image/jpeg' : (m.imageMessage.mimetype || 'image/jpeg'),
        filename: m.imageMessage.fileName,
        size: m.imageMessage.fileLength ? Number(m.imageMessage.fileLength) : undefined,
        data: data || undefined
      });
    }

    // Check for video (metadata only - too large for context)
    if (m.videoMessage) {
      attachments.push({
        contentType: m.videoMessage.mimetype || 'video/mp4',
        filename: m.videoMessage.fileName,
        size: m.videoMessage.fileLength ? Number(m.videoMessage.fileLength) : undefined
      });
    }

    // Check for document
    if (m.documentMessage) {
      attachments.push({
        contentType: m.documentMessage.mimetype || 'application/octet-stream',
        filename: m.documentMessage.fileName,
        size: m.documentMessage.fileLength ? Number(m.documentMessage.fileLength) : undefined
      });
    }

    // Check for audio
    if (m.audioMessage) {
      attachments.push({
        contentType: m.audioMessage.mimetype || 'audio/ogg',
        size: m.audioMessage.fileLength ? Number(m.audioMessage.fileLength) : undefined
      });
    }

    return attachments.length > 0 ? attachments : undefined;
  }

  /**
   * Download and compress image attachment
   */
  private async downloadAndCompress(msg: any): Promise<string | null> {
    try {
      const buffer = await this.session.downloadMediaMessage(msg);
      if (!buffer) return null;

      const originalSize = buffer.length;
      const compressed = await this.compressImage(buffer);
      if (!compressed) {
        console.warn(`[WhatsAppConnectionReceptor:${this.botPhone}] Compression failed, skipping attachment`);
        return null;
      }

      const base64 = compressed.toString('base64');
      console.log(`[WhatsAppConnectionReceptor:${this.botPhone}] Compressed attachment: ${originalSize} -> ${compressed.length} bytes`);
      return base64;
    } catch (error: any) {
      console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Error downloading attachment:`, error.message);
      return null;
    }
  }

  /**
   * Compress an image: resize to max dimension and convert to JPEG
   */
  private async compressImage(buffer: Buffer): Promise<Buffer | null> {
    try {
      const metadata = await sharp(buffer).metadata();
      const { width, height, format } = metadata;

      if (!width || !height) return null;

      const maxDim = Math.max(width, height);
      const needsResize = maxDim > IMAGE_MAX_DIMENSION;

      // Skip compression for small JPEGs already under size limit
      if (!needsResize && format === 'jpeg' && buffer.length <= IMAGE_MAX_BYTES) {
        return buffer;
      }

      let pipeline = sharp(buffer);

      if (needsResize) {
        pipeline = pipeline.resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      let compressed = await pipeline
        .jpeg({ quality: IMAGE_JPEG_QUALITY })
        .toBuffer();

      // Recompress if still too large
      if (compressed.length > IMAGE_MAX_BYTES) {
        compressed = await sharp(compressed)
          .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 50 })
          .toBuffer();
      }
      if (compressed.length > IMAGE_MAX_BYTES) {
        compressed = await sharp(compressed)
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 30 })
          .toBuffer();
      }

      return compressed;
    } catch (error) {
      console.error(`[WhatsAppConnectionReceptor:${this.botPhone}] Image compression failed:`, error);
      return null;
    }
  }
}
