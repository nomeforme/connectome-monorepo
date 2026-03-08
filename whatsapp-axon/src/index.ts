/**
 * WhatsApp AXON Module for Connectome
 *
 * Exports gRPC components for WhatsApp integration via Baileys.
 * All bots are remote: whatsapp-axon is purely a gateway.
 */

// Re-export everything from gRPC module
export * from './grpc/index.js';

// Also export message deduplicator (shared utility)
export { messageDeduplicator } from './message-deduplicator.js';
