/**
 * WhatsApp AXON gRPC Client
 * Connects whatsapp-axon to the central Connectome gRPC server
 */

import { ConnectomeClient, type ConnectomeClientConfig, type SubscriptionOptions, type FacetDelta } from '@connectome/grpc-common';
import { EventEmitter } from 'events';

/**
 * WhatsApp-specific gRPC client configuration
 */
export interface WhatsAppGrpcClientConfig {
  /** Connectome gRPC server host */
  serverHost: string;
  /** Connectome gRPC server port */
  serverPort?: number;
  /** Client identifier (usually bot name or phone) */
  clientId: string;
  /** Bot name for agent registration */
  botName: string;
  /** Stream type for WhatsApp messages */
  streamType?: string;
}

/**
 * WhatsApp gRPC Client
 * Wraps ConnectomeClient with WhatsApp-specific functionality
 */
export class WhatsAppGrpcClient extends EventEmitter {
  private client: ConnectomeClient;
  private config: WhatsAppGrpcClientConfig;
  private agentHandle?: { agentId: string; sessionToken: string };
  private unsubscribe?: () => void;

  constructor(config: WhatsAppGrpcClientConfig) {
    super();

    this.config = {
      ...config,
      serverPort: config.serverPort || 50051,
      streamType: config.streamType || 'whatsapp'
    };

    const clientConfig: ConnectomeClientConfig = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      clientId: this.config.clientId,
      reconnectInterval: 5000,
      maxReconnectAttempts: -1 // Infinite reconnect
    };

    this.client = new ConnectomeClient(clientConfig);

    // Forward connection events
    this.client.on('connected', () => this.emit('connected'));
    this.client.on('disconnected', () => this.emit('disconnected'));
    this.client.on('reconnected', () => this.emit('reconnected'));
    this.client.on('reconnect_failed', () => this.emit('reconnect_failed'));
    this.client.on('error', (error: Error) => this.emit('error', error));
  }

  /**
   * Connect to the Connectome server and register as an agent
   */
  async connect(): Promise<void> {
    console.log(`[WhatsAppGrpcClient] Connecting to ${this.config.serverHost}:${this.config.serverPort}...`);

    await this.client.connect();

    // Register as an agent
    const result = await this.client.registerAgent(
      `agent-${this.config.clientId}`,
      this.config.botName,
      {
        agentType: 'whatsapp-bot',
        capabilities: ['send-message', 'receive-message', 'mention-detection'],
        metadata: {
          clientId: this.config.clientId,
          streamType: this.config.streamType || 'whatsapp'
        }
      }
    );

    if (!result.success) {
      throw new Error(`Failed to register agent: ${result.error}`);
    }

    this.agentHandle = {
      agentId: result.agentId,
      sessionToken: result.sessionToken
    };

    console.log(`[WhatsAppGrpcClient] Registered agent: ${result.agentId}`);
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.client.disconnect();
    this.agentHandle = undefined;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Emit a WhatsApp message event
   */
  async emitWhatsAppMessage(message: {
    content: string;
    sender: string;
    senderJid: string;
    groupJid?: string;
    groupName?: string;
    botPhone: string;
    timestamp: number;
    attachments?: any[];
    mentionedJids?: string[];
    quotedMessage?: any;
    messageId: string;
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; sequence: number }> {
    const streamId = message.groupJid
      ? `whatsapp:group:${message.groupJid}`
      : `whatsapp:dm:${message.botPhone}:${message.senderJid}`;

    const result = await this.client.emitEvent(
      'whatsapp:message',
      {
        ...message,
        streamId,
        streamType: 'whatsapp'
      },
      {
        priority: 'high',
        waitForFrame: true,
        metadata: {
          botPhone: message.botPhone,
          streamId
        }
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Emit a WhatsApp message update event (message was edited)
   */
  async emitWhatsAppMessageUpdate(update: {
    content: string;
    sender: string;
    senderJid: string;
    groupJid?: string;
    groupName?: string;
    botPhone: string;
    messageId: string;
    editedTimestamp: number;
  }): Promise<{ success: boolean }> {
    const streamId = update.groupJid
      ? `whatsapp:group:${update.groupJid}`
      : `whatsapp:dm:${update.botPhone}:${update.senderJid}`;

    const result = await this.client.emitEvent(
      'whatsapp:messageUpdate',
      { ...update, streamId, streamType: 'whatsapp' },
      { priority: 'high', waitForFrame: true }
    );

    return { success: result.success };
  }

  /**
   * Emit a WhatsApp message delete event
   */
  async emitWhatsAppMessageDelete(del: {
    senderJid: string;
    groupJid?: string;
    botPhone: string;
    messageId: string;
  }): Promise<{ success: boolean }> {
    const streamId = del.groupJid
      ? `whatsapp:group:${del.groupJid}`
      : `whatsapp:dm:${del.botPhone}:${del.senderJid}`;

    const result = await this.client.emitEvent(
      'whatsapp:messageDelete',
      { ...del, streamId, streamType: 'whatsapp' },
      { priority: 'high', waitForFrame: true }
    );

    return { success: result.success };
  }

  /**
   * Emit a WhatsApp receipt event
   */
  async emitWhatsAppReceipt(receipt: {
    type: 'read' | 'delivered' | 'played';
    senderJid: string;
    timestamp: number;
    botPhone: string;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'whatsapp:receipt',
      receipt,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Emit a WhatsApp typing/presence event
   */
  async emitWhatsAppTyping(typing: {
    senderJid: string;
    groupJid?: string;
    type: string;
    timestamp: number;
    botPhone: string;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'whatsapp:typing',
      typing,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Subscribe to speech facets for outgoing messages
   */
  subscribeToSpeech(
    callback: (facet: any) => void,
    options?: {
      streamIds?: string[];
      agentName?: string;
    }
  ): () => void {
    const subOptions: SubscriptionOptions = {
      filters: [
        {
          types: ['speech'],
          aspectMatch: options?.agentName ? { agentName: options.agentName } : {}
        }
      ],
      includeExisting: false,
      streamIds: options?.streamIds || []
    };

    const unsub = this.client.subscribe(subOptions, (delta: FacetDelta) => {
      if (delta.type === 'added' && delta.facet) {
        callback(delta.facet);
      }
    });

    this.unsubscribe = unsub;
    return unsub || (() => {});
  }

  /**
   * Get rendered context for the agent
   */
  async getContext(
    streamId: string,
    options?: {
      maxFrames?: number;
    }
  ): Promise<any> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.getContext(
      this.agentHandle.agentId,
      streamId,
      {
        maxFrames: options?.maxFrames || 100
      }
    );

    return result.context;
  }

  /**
   * Create or get a stream for a conversation
   */
  async ensureStream(
    streamId: string,
    metadata?: {
      groupName?: string;
      participants?: string[];
      botPhone?: string;
    }
  ): Promise<string> {
    const conversationType = streamId.includes(':group:') ? 'group' : 'dm';

    await this.client.createStream(streamId, 'whatsapp', {
      conversationType,
      groupName: metadata?.groupName || '',
      participants: JSON.stringify(metadata?.participants || []),
      botPhone: metadata?.botPhone || ''
    });

    return streamId;
  }

  /**
   * Emit a generic event to the server
   */
  async emitEvent(
    topic: string,
    payload: Record<string, any>,
    options?: {
      priority?: 'low' | 'normal' | 'high';
      waitForFrame?: boolean;
    }
  ): Promise<{ success: boolean; sequence: number }> {
    const result = await this.client.emitEvent(
      topic,
      payload,
      {
        priority: options?.priority || 'normal',
        waitForFrame: options?.waitForFrame ?? true
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Activate agent for a stream
   */
  async activateAgent(
    streamId: string,
    reason?: string,
    metadata?: Record<string, string>
  ): Promise<{ success: boolean; activationId: string }> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.activateAgent(
      this.agentHandle.agentId,
      streamId,
      {
        reason: reason || 'whatsapp message received',
        priority: 'normal',
        metadata
      }
    );

    return {
      success: result.success,
      activationId: result.activationId
    };
  }

  /**
   * Get current health status
   */
  async health(): Promise<{
    healthy: boolean;
    currentSequence: number;
  }> {
    const status = await this.client.health();
    return {
      healthy: status.healthy,
      currentSequence: status.currentSequence
    };
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string | undefined {
    return this.agentHandle?.agentId;
  }
}
