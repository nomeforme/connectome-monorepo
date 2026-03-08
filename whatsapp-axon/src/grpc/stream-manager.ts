/**
 * Stream Manager for WhatsApp gRPC Client
 * Manages subscriptions and stream state for WhatsApp conversations
 */

import { WhatsAppGrpcClient } from './client.js';
import { EventEmitter } from 'events';

/**
 * Stream information
 */
export interface StreamInfo {
  streamId: string;
  conversationType: 'dm' | 'group';
  groupJid?: string;
  groupName?: string;
  contactJid?: string;
  botPhone: string;
  participants: string[];
  createdAt: number;
  lastMessageAt: number;
}

/**
 * Manages streams and subscriptions for WhatsApp conversations
 */
export class StreamManager extends EventEmitter {
  private client: WhatsAppGrpcClient;
  private streams: Map<string, StreamInfo> = new Map();
  private unsubscribes: Map<string, () => void> = new Map();
  private speechCallback?: (facet: any, streamInfo: StreamInfo) => void;

  constructor(client: WhatsAppGrpcClient) {
    super();
    this.client = client;
  }

  /**
   * Register a callback for speech facets
   */
  onSpeech(callback: (facet: any, streamInfo: StreamInfo) => void): void {
    this.speechCallback = callback;
  }

  /**
   * Get or create a stream for a conversation
   */
  async getOrCreateStream(
    conversationId: string,
    metadata: {
      conversationType: 'dm' | 'group';
      groupJid?: string;
      groupName?: string;
      contactJid?: string;
      botPhone: string;
      participants?: string[];
    }
  ): Promise<StreamInfo> {
    const streamId = this.buildStreamId(conversationId, metadata);

    // Check if stream already exists locally
    let info = this.streams.get(streamId);
    if (info) {
      // Update last message time
      info.lastMessageAt = Date.now();
      return info;
    }

    // Create new stream on server
    await this.client.ensureStream(streamId, {
      groupName: metadata.groupName,
      participants: metadata.participants,
      botPhone: metadata.botPhone
    });

    // Store stream info locally
    info = {
      streamId,
      conversationType: metadata.conversationType,
      groupJid: metadata.groupJid,
      groupName: metadata.groupName,
      contactJid: metadata.contactJid,
      botPhone: metadata.botPhone,
      participants: metadata.participants || [],
      createdAt: Date.now(),
      lastMessageAt: Date.now()
    };

    this.streams.set(streamId, info);

    // Subscribe to speech for this stream
    this.subscribeToStream(streamId);

    console.log(`[StreamManager] Created stream: ${streamId}`);

    return info;
  }

  /**
   * Build stream ID from conversation metadata
   * For DMs: includes botPhone to isolate each bot's conversation with a user
   * For groups: just uses group JID (all bots share same group context)
   */
  private buildStreamId(
    conversationId: string,
    metadata: { conversationType: 'dm' | 'group'; groupJid?: string; contactJid?: string; botPhone?: string }
  ): string {
    if (metadata.conversationType === 'group' && metadata.groupJid) {
      return `whatsapp:group:${metadata.groupJid}`;
    } else if (metadata.botPhone && metadata.contactJid) {
      return `whatsapp:dm:${metadata.botPhone}:${metadata.contactJid}`;
    } else if (metadata.contactJid) {
      return `whatsapp:dm:${metadata.contactJid}`;
    } else {
      return `whatsapp:${conversationId}`;
    }
  }

  /**
   * Subscribe to a specific stream
   */
  private subscribeToStream(streamId: string): void {
    // Avoid duplicate subscriptions
    if (this.unsubscribes.has(streamId)) {
      return;
    }

    const unsubscribe = this.client.subscribeToSpeech(
      (facet) => {
        const info = this.streams.get(streamId);
        if (info && this.speechCallback) {
          this.speechCallback(facet, info);
        }
        this.emit('speech', facet, info);
      },
      {
        streamIds: [streamId]
      }
    );

    this.unsubscribes.set(streamId, unsubscribe);
  }

  /**
   * Get stream by ID
   */
  getStream(streamId: string): StreamInfo | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get stream for a group
   */
  getStreamByGroupJid(groupJid: string): StreamInfo | undefined {
    const streamId = `whatsapp:group:${groupJid}`;
    return this.streams.get(streamId);
  }

  /**
   * Get all active streams
   */
  getAllStreams(): StreamInfo[] {
    return Array.from(this.streams.values());
  }

  /**
   * Clean up inactive streams
   */
  cleanupInactiveStreams(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const [streamId, info] of this.streams) {
      if (info.lastMessageAt < cutoff) {
        const unsub = this.unsubscribes.get(streamId);
        if (unsub) {
          unsub();
          this.unsubscribes.delete(streamId);
        }

        this.streams.delete(streamId);
        cleaned++;

        console.log(`[StreamManager] Cleaned up inactive stream: ${streamId}`);
      }
    }

    return cleaned;
  }

  /**
   * Unsubscribe from all streams
   */
  unsubscribeAll(): void {
    for (const [, unsub] of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes.clear();
  }

  /**
   * Get stats
   */
  getStats(): {
    totalStreams: number;
    dmStreams: number;
    groupStreams: number;
    activeSubscriptions: number;
  } {
    const streams = this.getAllStreams();
    return {
      totalStreams: streams.length,
      dmStreams: streams.filter(s => s.conversationType === 'dm').length,
      groupStreams: streams.filter(s => s.conversationType === 'group').length,
      activeSubscriptions: this.unsubscribes.size
    };
  }
}
