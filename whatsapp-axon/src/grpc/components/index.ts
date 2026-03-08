/**
 * gRPC Components - Client-side equivalents of Connectome Components
 *
 * Architecture mapping:
 * - Receptors: Handle WhatsApp events, emit to Connectome server
 * - Transforms: Fetch/render context from server
 * - Effectors: Send responses to WhatsApp
 */

// Receptors - Handle WhatsApp events
export { WhatsAppConnectionReceptor } from './whatsapp-connection-receptor.js';
export type { WhatsAppConnectionReceptorConfig } from './whatsapp-connection-receptor.js';

export { WhatsAppMessageReceptor } from './whatsapp-message-receptor.js';
export type { WhatsAppMessageReceptorConfig } from './whatsapp-message-receptor.js';

export { WhatsAppReceiptReceptor } from './whatsapp-receipt-receptor.js';
export type { WhatsAppReceiptReceptorConfig } from './whatsapp-receipt-receptor.js';

export { WhatsAppTypingReceptor } from './whatsapp-typing-receptor.js';
export type { WhatsAppTypingReceptorConfig } from './whatsapp-typing-receptor.js';

// Transforms - Fetch and render context
export { FocusedContextTransform } from './focused-context-transform.js';
export type { FocusedContextTransformConfig, RenderedContext, ContextMessage } from './focused-context-transform.js';

// Effectors - Send responses to WhatsApp
export { WhatsAppSpeechEffector } from './whatsapp-speech-effector.js';
export type { WhatsAppSpeechEffectorConfig } from './whatsapp-speech-effector.js';

export { WhatsAppCommandEffector } from './whatsapp-command-effector.js';
export type { ConfigUpdateCallback } from './whatsapp-command-effector.js';
