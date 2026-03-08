#!/usr/bin/env node
/**
 * WhatsApp AXON gRPC Client Entry Point (Multi-Bot)
 * Connects multiple WhatsApp bots to the Connectome gRPC server via Baileys
 *
 * Architecture:
 * - Phones arrive via WHATSAPP_BOT_PHONES env var (startup batch) and/or
 *   AxonBindingServer advertisements from bot-runtimes (dynamic)
 * - Names from WHATSAPP_BOT_NAMES env var (index-matched)
 * - Creates one gRPC client + Baileys session per bot
 * - Uses class-based components following Connectome nomenclature
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: 'whatsapp-axon' });

import { AxonBindingServer } from '@connectome/axon-binding';
import type { AxonBinding } from '@connectome/axon-binding';

import {
  // Configuration
  getPhones,
  getBotNames,
  getGrpcConfig,
  getOperationalConfig,
  phoneToJid,
  // Baileys session
  BaileysSession,
  // Bot instance
  createBotInstance,
  // Components
  WhatsAppConnectionReceptor,
  WhatsAppMessageReceptor,
  WhatsAppReceiptReceptor,
  WhatsAppTypingReceptor,
  FocusedContextTransform,
  WhatsAppSpeechEffector,
  WhatsAppCommandEffector,
  // Utilities
  getNameToJidCache,
  // Types
  type SharedState,
  type RuntimeConfig,
  type BotInstance,
  type BotConfig,
  type WhatsAppMessageEvent
} from './grpc/index.js';
import { messageDeduplicator } from './message-deduplicator.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   WHATSAPP AXON - gRPC Client Mode (Multi-Bot)        ║');
  console.log('║   WhatsApp adapter for Connectome via Baileys          ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  // Load configuration from environment
  const phones = getPhones();
  const envNames = getBotNames();
  const operationalConfig = getOperationalConfig();
  const { host, port } = getGrpcConfig();
  const bindingPort = parseInt(process.env.AXON_BINDING_PORT || '0');

  console.log('Configuration:');
  console.log(`  Connectome gRPC:    ${host}:${port}`);
  console.log(`  Phones (env):       ${phones.length}`);
  console.log(`  Names (env):        ${envNames.length}`);
  console.log(`  Axon binding:       ${bindingPort || 'disabled'}`);
  console.log(`  Max message length: ${operationalConfig.maxMessageLength}`);
  console.log(`  Privacy mode:       ${operationalConfig.groupPrivacyMode}`);
  console.log();

  // Shared caches
  const nameToJidCache = getNameToJidCache();

  // Build managed bot name set (for speech routing)
  const managedBotNames = new Set<string>();

  // Phone/JID/name mappings (mutable — grow as bots are added)
  const phoneToName = new Map<string, string>();
  const botJidToName = new Map<string, string>();

  // Store sessions for direct access (command responses, shutdown)
  const sessions = new Map<string, BaileysSession>();

  // Initialize shared state
  const state: SharedState = {
    bots: new Map<string, BotInstance>(),
    botJidToName,
    botPhoneToName: phoneToName,
    processingActivations: new Set<string>(),
    botInteractionCounts: new Map<string, number>(),
    runtimeConfig: {
      randomReplyChance: operationalConfig.randomReplyChance,
      maxBotMentionsPerConversation: operationalConfig.maxBotMentionsPerConversation,
      maxConversationFrames: operationalConfig.maxConversationFrames,
      maxMemoryFrames: operationalConfig.maxMemoryFrames,
      groupPrivacyMode: operationalConfig.groupPrivacyMode
    }
  };

  // Store context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  // Store speech effectors for direct command responses
  const speechEffectors = new Map<string, WhatsAppSpeechEffector>();

  const updateRuntimeConfig = (updates: Partial<RuntimeConfig>) => {
    Object.assign(state.runtimeConfig, updates);
    console.log('[RuntimeConfig] Updated:', updates);
    if (updates.maxConversationFrames !== undefined) {
      for (const ct of contextTransforms) {
        ct.setMaxConversationFrames(updates.maxConversationFrames);
      }
    }
  };

  // ========================================================================
  // addWhatsAppBot — reusable: initialize a single WhatsApp bot
  // Called both at startup (env phones) and dynamically (binding ads)
  // ========================================================================
  async function addWhatsAppBot(
    name: string, phone: string, source: string
  ): Promise<boolean> {
    if (state.bots.has(phone)) {
      console.log(`  ${name}: Already managed, skipping (${source})`);
      return true;
    }

    console.log(`  Initializing ${name} (${phone}) [${source}]...`);

    const jid = phoneToJid(phone);

    // Update caches
    phoneToName.set(phone, name);
    managedBotNames.add(name);
    botJidToName.set(jid, name);
    nameToJidCache.set(name.toLowerCase(), jid);

    const botConfig: BotConfig = { name, phone, jid };
    const bot = createBotInstance(botConfig, host, port);
    state.bots.set(phone, bot);

    // Create Baileys session
    const session = new BaileysSession({ phone, name });
    sessions.set(phone, session);

    // Create components
    const speechEffector = new WhatsAppSpeechEffector({
      botConfig: bot.config,
      streamManager: bot.streamManager,
      session,
      managedBotNames,
      maxMessageLength: operationalConfig.maxMessageLength
    });
    speechEffector.setup();
    speechEffectors.set(phone, speechEffector);

    const contextTransform = new FocusedContextTransform({
      grpcClient: bot.grpcClient,
      botName: name,
      systemPrompt: 'Standard',
      maxConversationFrames: state.runtimeConfig.maxConversationFrames,
    });
    contextTransforms.push(contextTransform);

    const commandEffector = new WhatsAppCommandEffector(name);

    const messageReceptor = new WhatsAppMessageReceptor({
      bot, state, commandEffector, updateConfig: updateRuntimeConfig
    });

    const receiptReceptor = new WhatsAppReceiptReceptor({ bot });
    const typingReceptor = new WhatsAppTypingReceptor({ bot });

    // Wire Baileys events → receptors
    const connectionReceptor = new WhatsAppConnectionReceptor({
      session,
      botPhone: phone,
      botJid: jid,
      onMessage: async (event) => {
        await messageReceptor.handleMessage(event);
      },
      onEdit: async (event) => {
        const isGroup = !!event.groupJid;
        const dedupeKey = `edit-${event.senderJid}-${event.messageId}`;
        if (isGroup && !messageDeduplicator.shouldEmit(dedupeKey, phone, true)) {
          return;
        }
        try {
          await bot.grpcClient.emitWhatsAppMessageUpdate({
            content: event.content,
            sender: event.sender,
            senderJid: event.senderJid,
            groupJid: event.groupJid,
            groupName: event.groupName,
            botPhone: phone,
            messageId: event.messageId,
            editedTimestamp: event.editedTimestamp
          });
          console.log(`[WhatsAppAxon:${name}] Emitted messageUpdate for ${event.messageId}: ${event.content.substring(0, 50)}...`);
        } catch (error: any) {
          console.error(`[WhatsAppAxon:${name}] Error emitting messageUpdate:`, error.message);
        }
      },
      onDelete: async (event) => {
        const isGroup = !!event.groupJid;
        const dedupeKey = `delete-${event.senderJid}-${event.messageId}`;
        if (isGroup && !messageDeduplicator.shouldEmit(dedupeKey, phone, true)) {
          return;
        }
        try {
          await bot.grpcClient.emitWhatsAppMessageDelete({
            senderJid: event.senderJid,
            groupJid: event.groupJid,
            botPhone: phone,
            messageId: event.messageId
          });
          console.log(`[WhatsAppAxon:${name}] Emitted messageDelete for ${event.messageId}`);
        } catch (error: any) {
          console.error(`[WhatsAppAxon:${name}] Error emitting messageDelete:`, error.message);
        }
      },
      onReceipt: async (updates) => {
        await receiptReceptor.handleReceipts(updates);
      },
      onTyping: async (update) => {
        await typingReceptor.handlePresence(update);
      }
    });

    connectionReceptor.setup();

    // Listen for command responses (from message receptor)
    bot.grpcClient.on('connected', () => {
      // Subscribe to command response events for this bot
    });

    // Connect gRPC and start Baileys session
    try {
      await bot.grpcClient.connect();
      await session.start();
      console.log(`  ${name}: Components initialized, connected [${source}]`);
      return true;
    } catch (error: any) {
      console.error(`  ${name}: Failed to connect: ${error.message}`);
      // Clean up
      state.bots.delete(phone);
      phoneToName.delete(phone);
      managedBotNames.delete(name);
      botJidToName.delete(jid);
      nameToJidCache.delete(name.toLowerCase());
      sessions.delete(phone);
      speechEffectors.delete(phone);
      return false;
    }
  }

  // ========================================================================
  // Step 1: Start AxonBindingServer FIRST (so bot-runtimes can connect
  // while env-based bots are still initializing)
  // ========================================================================
  let bindingServer: AxonBindingServer | undefined;

  if (bindingPort > 0) {
    bindingServer = new AxonBindingServer({ port: bindingPort });

    // Queue binding advertisements (serialize Baileys session creation)
    const bindingQueue: AxonBinding[] = [];
    let processingBindings = false;

    async function processBindingQueue(): Promise<void> {
      if (processingBindings) return;
      processingBindings = true;
      while (bindingQueue.length > 0) {
        const binding = bindingQueue.shift()!;
        const phone = binding.credentials.phone;
        if (!phone) {
          console.error(`[AxonBinding] WhatsApp binding for ${binding.agentName} missing phone`);
          continue;
        }
        console.log(`[AxonBinding] Adding bot ${binding.agentName}...`);
        await addWhatsAppBot(
          binding.agentName,
          phone,
          `binding:${binding.agentName}`
        );
      }
      processingBindings = false;
    }

    bindingServer.on('binding:added', (binding: AxonBinding) => {
      if (binding.platform !== 'whatsapp') {
        console.log(`[AxonBinding] Ignoring non-whatsapp binding: ${binding.agentName} → ${binding.platform}`);
        return;
      }
      bindingQueue.push(binding);
      processBindingQueue();
    });

    await bindingServer.start();
  }

  // ========================================================================
  // Step 2: Initialize bots from env vars (startup batch)
  // ========================================================================
  if (phones.length > 0) {
    if (envNames.length < phones.length) {
      console.error(`Error: WHATSAPP_BOT_NAMES has ${envNames.length} names but WHATSAPP_BOT_PHONES has ${phones.length} phones`);
      console.error('Set WHATSAPP_BOT_NAMES (comma-separated, matching WHATSAPP_BOT_PHONES by index)');
      process.exit(1);
    }

    console.log(`Initializing ${phones.length} bot(s) from env...`);

    for (let i = 0; i < phones.length; i++) {
      const phone = phones[i];
      const name = envNames[i];
      await addWhatsAppBot(name, phone, 'env');
    }

    console.log(`  ${state.bots.size} bot(s) initialized from env`);
    console.log();
  }

  if (state.bots.size === 0 && !bindingServer) {
    console.error('Error: No bots initialized and no binding server running');
    process.exit(1);
  }

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n\nShutting down...');

    if (bindingServer) {
      await bindingServer.stop();
    }

    // Close Baileys sessions
    for (const [phone, session] of sessions) {
      const botName = phoneToName.get(phone);
      console.log(`  Closing ${botName} Baileys session...`);
      await session.close();
    }

    // Disconnect gRPC
    for (const [botPhone, bot] of state.bots) {
      const botName = phoneToName.get(botPhone);
      console.log(`  Disconnecting ${botName}...`);
      bot.streamManager.unsubscribeAll();
      bot.grpcClient.disconnect();
    }

    await Sentry.flush(2000);
    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  WhatsApp AXON running with ${state.bots.size} bot(s)`);
  if (bindingServer) {
    console.log(`  Axon binding server on port ${bindingPort}`);
  }
  console.log('  Listening for WhatsApp messages...');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nPress Ctrl+C to stop.\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
