/**
 * FocusedContextTransform - gRPC equivalent for WhatsApp
 *
 * Fetches and renders per-agent context from the Connectome server:
 * 1. Fetches VEIL state via gRPC GetContext
 * 2. Transforms server facets into LLM-compatible messages
 * 3. Injects bot identity into system prompt
 * 4. Filters by stream (conversation) to avoid cross-context pollution
 */

import type { WhatsAppGrpcClient } from '../client.js';

/**
 * Message format for LLM context
 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  metadata?: {
    attachments?: Array<{
      contentType?: string;
      data?: string;
    }>;
  };
}

/**
 * Rendered context for the agent
 */
export interface RenderedContext {
  messages: ContextMessage[];
  metadata: {
    totalTokens?: number;
    frameCount: number;
    streamId?: string;
  };
}

export interface FocusedContextTransformConfig {
  grpcClient: WhatsAppGrpcClient;
  botName: string;
  systemPrompt: string;
  maxConversationFrames: number;
  skipIdentityPrompt?: boolean;
}

/**
 * FocusedContextTransform - Renders context for agent activation
 */
export class FocusedContextTransform {
  private grpcClient: WhatsAppGrpcClient;
  private botName: string;
  private systemPrompt: string;
  private maxConversationFrames: number;
  private skipIdentityPrompt: boolean;

  constructor(config: FocusedContextTransformConfig) {
    this.grpcClient = config.grpcClient;
    this.botName = config.botName;
    this.systemPrompt = config.systemPrompt;
    this.maxConversationFrames = config.maxConversationFrames;
    this.skipIdentityPrompt = config.skipIdentityPrompt ?? false;
  }

  /**
   * Update max conversation frames (for runtime config changes)
   */
  setMaxConversationFrames(value: number): void {
    this.maxConversationFrames = value;
    console.log(`[FocusedContextTransform:${this.botName}] maxConversationFrames set to ${value}`);
  }

  /**
   * Render context for the agent
   */
  async renderContext(
    streamId: string,
    options?: {
      maxFrames?: number;
      currentMessage?: {
        content: string;
        senderName: string;
      };
    }
  ): Promise<RenderedContext> {
    const maxFrames = options?.maxFrames ?? this.maxConversationFrames;

    try {
      const serverContext = await this.grpcClient.getContext(streamId, { maxFrames });

      const messages = this.transformToMessages(serverContext);

      if (options?.currentMessage) {
        const currentContent = `<${options.currentMessage.senderName}> ${options.currentMessage.content}`;
        const hasCurrentMessage = messages.some(m =>
          m.role === 'user' && m.content.includes(options.currentMessage!.content)
        );

        if (!hasCurrentMessage) {
          messages.push({
            role: 'user',
            content: currentContent
          });
        }
      }

      return {
        messages,
        metadata: {
          frameCount: serverContext?.metadata?.frameCount || 0,
          streamId
        }
      };
    } catch (error: any) {
      console.warn(`[FocusedContextTransform:${this.botName}] Context fetch failed:`, error.message);

      if (options?.currentMessage) {
        return this.buildFallbackContext(options.currentMessage.content, options.currentMessage.senderName);
      }

      return this.buildMinimalContext();
    }
  }

  /**
   * Transform server context to LLM messages
   */
  private transformToMessages(serverContext: any): ContextMessage[] {
    const messages: ContextMessage[] = [];

    const systemContent = this.buildSystemPrompt();
    messages.push({ role: 'system', content: systemContent });

    if (serverContext?.conversation && Array.isArray(serverContext.conversation)) {
      for (const msg of serverContext.conversation) {
        if (msg.internal) continue;
        const role = msg.role as 'system' | 'user' | 'assistant';
        if (role === 'system') continue;

        if (role === 'user' || role === 'assistant') {
          const message: ContextMessage = { role, content: msg.content || '' };
          if (msg.metadata?.attachments?.length > 0) {
            message.metadata = { attachments: msg.metadata.attachments };
          }
          messages.push(message);
        }
      }
    }

    return messages;
  }

  /**
   * Build system prompt with bot identity and WhatsApp capabilities
   */
  private buildSystemPrompt(): string {
    const identityPrompt = this.skipIdentityPrompt ? '' : `You are <${this.botName}> in WhatsApp.

To mention users, use @username syntax. The system will convert usernames to WhatsApp mention format automatically.

WhatsApp supports these text formatting options:
- *bold* for bold
- _italic_ for italic
- ~strikethrough~ for strikethrough
- \`monospace\` for monospace
- \`\`\`code block\`\`\` for code blocks`;

    if (this.systemPrompt && this.systemPrompt !== 'Standard') {
      if (identityPrompt) {
        return `${this.systemPrompt}\n\n${identityPrompt}`;
      }
      return this.systemPrompt;
    }

    return identityPrompt;
  }

  /**
   * Build minimal context when server is unavailable
   */
  private buildMinimalContext(): RenderedContext {
    return {
      messages: [{ role: 'system', content: this.buildSystemPrompt() }],
      metadata: { frameCount: 0 }
    };
  }

  /**
   * Build fallback context with a single user message
   */
  buildFallbackContext(messageContent: string, senderName: string): RenderedContext {
    return {
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        { role: 'user', content: `<${senderName}> ${messageContent}` }
      ],
      metadata: { frameCount: 1 }
    };
  }
}
