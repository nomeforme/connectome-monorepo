/**
 * BaileysSession - Manages a single Baileys WhatsApp connection
 *
 * Handles:
 * - Multi-file auth state persistence
 * - QR code / pairing code authentication
 * - Reconnection with exponential backoff
 * - Group metadata caching
 * - Message sending with typing simulation
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, type WASocket, type GroupMetadata } from '@whiskeysockets/baileys';
import pino from 'pino';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

const logger = pino({ level: 'warn' });

/**
 * Auth state directory base
 */
const AUTH_STATE_BASE = process.env.AUTH_STATE_DIR || path.resolve(process.cwd(), 'auth-state');

/**
 * Group metadata cache entry
 */
interface CachedGroupMeta {
  metadata: GroupMetadata;
  fetchedAt: number;
}

/**
 * Session configuration
 */
export interface BaileysSessionConfig {
  phone: string;
  name: string;
}

/**
 * Events emitted by BaileysSession
 */
export interface BaileysSessionEvents {
  'messages.upsert': (messages: any[], type: string) => void;
  'messages.update': (updates: any[]) => void;
  'messages.delete': (item: any) => void;
  'message-receipt.update': (updates: any[]) => void;
  'presence.update': (update: any) => void;
  'connection.update': (update: any) => void;
  'creds.update': () => void;
}

/**
 * BaileysSession - Single WhatsApp bot session
 */
export class BaileysSession extends EventEmitter {
  private config: BaileysSessionConfig;
  private sock: WASocket | null = null;
  private authDir: string;
  private reconnectDelay = 5000;
  private readonly maxReconnectDelay = 5 * 60 * 1000; // 5 minutes
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private groupMetaCache = new Map<string, CachedGroupMeta>();
  private readonly GROUP_META_TTL = 5 * 60 * 1000; // 5 minutes
  private connected = false;
  private closing = false;

  constructor(config: BaileysSessionConfig) {
    super();
    this.config = config;
    this.authDir = path.join(AUTH_STATE_BASE, config.phone.replace(/\+/g, ''));
  }

  /**
   * Get the underlying WASocket (for direct Baileys API calls)
   */
  getSocket(): WASocket | null {
    return this.sock;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Start the session — creates socket, sets up event handlers
   */
  async start(): Promise<void> {
    // Ensure auth directory exists
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[BaileysSession:${this.config.name}] Starting with Baileys v${version.join('.')}, auth dir: ${this.authDir}`);

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      // Mobile pairing for headless environments
      browser: ['Connectome', 'Chrome', '10.0'],
      // Keep alive
      keepAliveIntervalMs: 30000,
      // Retry connection
      retryRequestDelayMs: 2000,
      // Mark online
      markOnlineOnConnect: true,
    });

    // Persist credentials on every change
    this.sock.ev.on('creds.update', saveCreds);

    // Connection state changes
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[BaileysSession:${this.config.name}] QR code displayed in terminal. Scan to authenticate.`);
        // Also attempt pairing code for headless
        try {
          const pairingCode = await this.sock!.requestPairingCode(this.config.phone.replace(/\+/g, ''));
          console.log(`[BaileysSession:${this.config.name}] Pairing code: ${pairingCode}`);
        } catch {
          // Pairing code may not be available for all accounts
        }
      }

      if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[BaileysSession:${this.config.name}] Connection closed (status: ${statusCode}, reconnect: ${shouldReconnect})`);

        if (shouldReconnect && !this.closing) {
          this.scheduleReconnect();
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.error(`[BaileysSession:${this.config.name}] LOGGED OUT — clearing auth state and stopping`);
          // Clear auth state
          try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
          this.emit('logged-out');
        }
      }

      if (connection === 'open') {
        this.connected = true;
        this.reconnectDelay = 5000; // Reset on successful connect
        console.log(`[BaileysSession:${this.config.name}] Connected!`);
        this.emit('connected');
      }
    });

    // Forward message events
    this.sock.ev.on('messages.upsert', (m) => {
      this.emit('messages.upsert', m.messages, m.type);
    });

    this.sock.ev.on('messages.update', (updates) => {
      this.emit('messages.update', updates);
    });

    this.sock.ev.on('messages.delete', (item) => {
      this.emit('messages.delete', item);
    });

    this.sock.ev.on('message-receipt.update', (updates) => {
      this.emit('message-receipt.update', updates);
    });

    // Presence updates (typing indicators)
    this.sock.ev.on('presence.update', (update) => {
      this.emit('presence.update', update);
    });
  }

  /**
   * Send a text message
   */
  async sendMessage(jid: string, content: { text: string; mentions?: string[] }): Promise<any> {
    if (!this.sock) throw new Error('Session not started');
    return await this.sock.sendMessage(jid, content);
  }

  /**
   * Send presence update (composing / paused / available)
   */
  async sendPresenceUpdate(type: 'composing' | 'paused' | 'available' | 'unavailable', jid: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.presenceSubscribe(jid);
    await this.sock.sendPresenceUpdate(type, jid);
  }

  /**
   * Mark messages as read
   */
  async readMessages(keys: any[]): Promise<void> {
    if (!this.sock) return;
    await this.sock.readMessages(keys);
  }

  /**
   * Get group metadata with caching
   */
  async groupMetadata(groupJid: string): Promise<GroupMetadata | undefined> {
    // Check cache
    const cached = this.groupMetaCache.get(groupJid);
    if (cached && Date.now() - cached.fetchedAt < this.GROUP_META_TTL) {
      return cached.metadata;
    }

    if (!this.sock) return undefined;

    try {
      const metadata = await this.sock.groupMetadata(groupJid);
      this.groupMetaCache.set(groupJid, {
        metadata,
        fetchedAt: Date.now()
      });
      return metadata;
    } catch (error: any) {
      console.error(`[BaileysSession:${this.config.name}] Failed to fetch group metadata for ${groupJid}:`, error.message);
      return cached?.metadata;
    }
  }

  /**
   * Download media from a message
   */
  async downloadMediaMessage(message: any): Promise<Buffer | null> {
    if (!this.sock) return null;
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(message, 'buffer', {});
      return buffer as Buffer;
    } catch (error: any) {
      console.error(`[BaileysSession:${this.config.name}] Failed to download media:`, error.message);
      return null;
    }
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.connected = false;
    this.groupMetaCache.clear();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.closing) return;

    console.log(`[BaileysSession:${this.config.name}] Reconnecting in ${this.reconnectDelay / 1000}s...`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.start();
      } catch (error: any) {
        console.error(`[BaileysSession:${this.config.name}] Reconnect failed:`, error.message);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
