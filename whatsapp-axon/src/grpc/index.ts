/**
 * WhatsApp AXON gRPC exports
 */

// Core clients
export { WhatsAppGrpcClient, type WhatsAppGrpcClientConfig } from './client.js';
export { StreamManager, type StreamInfo } from './stream-manager.js';

// Types
export * from './types.js';

// Configuration
export { getPhones, getBotNames, getGrpcConfig, getOperationalConfig, phoneToJid } from './config-loader.js';

// Baileys session
export { BaileysSession, type BaileysSessionConfig } from './baileys-session.js';

// Bot instance management
export { createBotInstance } from './bot-instance.js';

// Components (class-based, Connectome nomenclature)
export * from './components/index.js';

// Utilities
export * from './utils/index.js';
