/**
 * Configuration loading for WhatsApp AXON gRPC mode
 *
 * Phone numbers from env vars or axon binding, names from WHATSAPP_BOT_NAMES env.
 */

/**
 * Parse bot phone numbers from environment
 */
export function getPhones(): string[] {
  const phonesEnv = process.env.WHATSAPP_BOT_PHONES || '';
  const phones = phonesEnv.split(',').map(p => p.trim()).filter(p => p);

  if (phones.length === 0) {
    console.log('No WHATSAPP_BOT_PHONES set — bots will arrive via axon binding');
  } else {
    console.log(`Found ${phones.length} phone(s) in WHATSAPP_BOT_PHONES`);
  }

  return phones;
}

/**
 * Parse bot names from environment (comma-separated, index-matched with phones)
 */
export function getBotNames(): string[] {
  const namesEnv = process.env.WHATSAPP_BOT_NAMES || '';
  return namesEnv.split(',').map(n => n.trim()).filter(n => n);
}

/**
 * Get gRPC server configuration from environment
 */
export function getGrpcConfig(): { host: string; port: number } {
  const grpcHost = process.env.CONNECTOME_GRPC_HOST || 'localhost:50051';
  const [host, portStr] = grpcHost.split(':');
  const port = parseInt(portStr) || 50051;
  return { host, port };
}

/**
 * Parse operational config from environment with defaults
 */
export function getOperationalConfig(): {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  maxMessageLength: number;
  groupPrivacyMode: 'opt-in' | 'opt-out';
} {
  const mode = process.env.GROUP_PRIVACY_MODE;
  return {
    randomReplyChance: parseInt(process.env.RANDOM_REPLY_CHANCE || '200') || 0,
    maxBotMentionsPerConversation: parseInt(process.env.MAX_BOT_MENTIONS || '1') || 1,
    maxConversationFrames: parseInt(process.env.MAX_CONVERSATION_FRAMES || '100') || 100,
    maxMemoryFrames: 500,
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '4096') || 4096,
    groupPrivacyMode: (mode === 'opt-in' ? 'opt-in' : 'opt-out'),
  };
}

/**
 * Build JID from phone number
 */
export function phoneToJid(phone: string): string {
  // Strip leading + if present
  const cleaned = phone.replace(/^\+/, '');
  return `${cleaned}@s.whatsapp.net`;
}
