/**
 * Type definitions for WhatsApp AXON gRPC mode
 *
 * Bot identities come from WHATSAPP_BOT_PHONES + WHATSAPP_BOT_NAMES env vars
 * or dynamically via AxonBindingServer advertisements from bot-runtimes.
 */

import type { WhatsAppGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';

/**
 * Bot configuration
 *
 * name comes from WHATSAPP_BOT_NAMES env or axon binding.
 * phone comes from WHATSAPP_BOT_PHONES env or axon binding credentials.
 * jid is derived: phone@s.whatsapp.net
 */
export interface BotConfig {
  name: string;
  phone: string;
  jid: string;  // phone@s.whatsapp.net
}

/**
 * Runtime configuration (from env vars with defaults, tunable via ! commands)
 */
export interface RuntimeConfig {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  groupPrivacyMode: 'opt-in' | 'opt-out';
}

/**
 * Runtime bot instance
 */
export interface BotInstance {
  config: BotConfig;
  grpcClient: WhatsAppGrpcClient;
  streamManager: StreamManager;
}

/**
 * Shared state across all bot instances
 */
export interface SharedState {
  /** Map from bot phone to bot instance */
  bots: Map<string, BotInstance>;
  /** Map from bot JID to bot name */
  botJidToName: Map<string, string>;
  /** Map from bot phone to bot name */
  botPhoneToName: Map<string, string>;
  /** Track activations currently being processed (dedup) */
  processingActivations: Set<string>;
  /** Track bot-to-bot interaction counts per stream */
  botInteractionCounts: Map<string, number>;
  /** Runtime configuration */
  runtimeConfig: RuntimeConfig;
}

/**
 * WhatsApp message event payload
 */
export interface WhatsAppMessageEvent {
  content: string;
  sender: string;
  senderJid: string;
  groupJid?: string;
  groupName?: string;
  botPhone: string;
  timestamp: number;
  attachments?: WhatsAppAttachment[];
  mentionedJids?: string[];
  quotedMessage?: WhatsAppQuote;
  messageId: string;
}

/**
 * WhatsApp attachment
 */
export interface WhatsAppAttachment {
  contentType?: string;
  filename?: string;
  size?: number;
  data?: string;  // base64 encoded
}

/**
 * WhatsApp quote/reply
 */
export interface WhatsAppQuote {
  messageId?: string;
  participant?: string;  // JID of the original sender
  text?: string;
}
