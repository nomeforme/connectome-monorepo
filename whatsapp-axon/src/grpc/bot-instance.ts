/**
 * Bot instance management for WhatsApp AXON gRPC mode
 * Handles creation and setup of individual bot instances
 *
 * All bots are remote: cognition is delegated to standalone bot-runtime containers.
 * WhatsApp-axon is purely a gateway.
 */

import { WhatsAppGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import type { BotConfig, BotInstance } from './types.js';

/**
 * Create a bot instance from discovered identity
 */
export function createBotInstance(
  botConfig: BotConfig,
  grpcHost: string,
  grpcPort: number
): BotInstance {
  const botPhone = botConfig.phone;

  // Create gRPC client for this bot
  const grpcClient = new WhatsAppGrpcClient({
    serverHost: grpcHost,
    serverPort: grpcPort,
    clientId: `whatsapp-${botPhone}`,
    botName: botConfig.name
  });

  // Create stream manager for this bot
  const streamManager = new StreamManager(grpcClient);

  const botInstance: BotInstance = {
    config: botConfig,
    grpcClient,
    streamManager
  };

  // Remote bots delegate cognition to external bot-runtime
  console.log(`  ${botConfig.name}: Remote mode — cognition delegated to bot-runtime`);

  return botInstance;
}
