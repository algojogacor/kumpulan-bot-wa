/**
 * Flash Peak TMS - WhatsApp Socket Lifecycle Manager
 * 
 * Manages Baileys connection state, authentication persistence outside business
 * tables, and anti-ban exponential backoff safeguards.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState,
  type UserFacingSocketConfig,
} from '@whiskeysockets/baileys';
import pino from 'pino';

export type ConnectionStatus =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'LOGGED_OUT';

export interface WhatsAppConnectionConfig {
  authStateDir?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxRetries?: number;
  logLevel?: pino.LevelWithSilent;
  printQRInTerminal?: boolean;
  browser?: [string, string, string];
  /**
   * Optional custom socket factory for unit testing and offline mocking.
   */
  customSocketFactory?: (config: Partial<UserFacingSocketConfig>) => Promise<WASocket> | WASocket;
  /**
   * Optional custom auth provider for unit testing.
   */
  customAuthStateProvider?: (dir: string) => Promise<{ state: any; saveCreds: () => Promise<void> }>;
}

export class WhatsAppConnection extends EventEmitter {
  private config: Required<Omit<WhatsAppConnectionConfig, 'customSocketFactory' | 'customAuthStateProvider'>> & {
    customSocketFactory?: WhatsAppConnectionConfig['customSocketFactory'];
    customAuthStateProvider?: WhatsAppConnectionConfig['customAuthStateProvider'];
  };
  private status: ConnectionStatus = 'IDLE';
  private retryCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sock: WASocket | null = null;
  private isExplicitDisconnect = false;
  private logger: pino.Logger;

  constructor(config?: WhatsAppConnectionConfig) {
    super();

    const authDir = config?.authStateDir || process.env.WA_AUTH_STATE_DIR || './auth_state';
    const baseDelay = config?.reconnectBaseDelayMs || Number(process.env.WA_RECONNECT_BASE_DELAY_MS) || 2000;
    const maxRetries = config?.maxRetries || Number(process.env.WA_RECONNECT_MAX_RETRIES) || 10;
    const logLevel = config?.logLevel || (process.env.LOG_LEVEL as pino.LevelWithSilent) || 'silent';

    this.logger = pino({ level: logLevel });

    this.config = {
      authStateDir: authDir,
      reconnectBaseDelayMs: baseDelay,
      reconnectMaxDelayMs: config?.reconnectMaxDelayMs || 60000,
      maxRetries,
      logLevel,
      printQRInTerminal: config?.printQRInTerminal ?? false,
      browser: config?.browser || ['FlashPeak TMS', 'Chrome', '1.0.0'],
      customSocketFactory: config?.customSocketFactory,
      customAuthStateProvider: config?.customAuthStateProvider,
    };
  }

  /**
   * Returns the current connection status.
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Returns current retry attempt counter.
   */
  public getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Returns the active WASocket instance, or null if not connected.
   */
  public getSocket(): WASocket | null {
    return this.sock;
  }

  /**
   * Initializes auth state and opens the WhatsApp socket connection.
   */
  public async connect(): Promise<WASocket> {
    if (this.status === 'CONNECTING' || this.status === 'CONNECTED') {
      if (this.sock) return this.sock;
    }

    this.isExplicitDisconnect = false;
    this.setStatus('CONNECTING');

    try {
      // Ensure auth storage directory exists with restricted access
      if (!existsSync(this.config.authStateDir)) {
        mkdirSync(this.config.authStateDir, { recursive: true, mode: 0o700 });
      }

      // Load auth state from filesystem (never from business tables)
      const { state, saveCreds } = this.config.customAuthStateProvider
        ? await this.config.customAuthStateProvider(this.config.authStateDir)
        : await useMultiFileAuthState(this.config.authStateDir);

      let version: [number, number, number] = [2, 3000, 1043857760];
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch (err) {
        this.logger.warn({ err }, 'Failed to fetch latest WA version, using fallback');
      }

      const socketConfig: Partial<UserFacingSocketConfig> = {
        version,
        auth: state,
        logger: this.logger as any,
        printQRInTerminal: this.config.printQRInTerminal,
        browser: this.config.browser,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => !jid || jid.endsWith('@broadcast') || jid === 'status@broadcast' || jid.endsWith('@newsletter'),
      };

      const sock: WASocket = this.config.customSocketFactory
        ? await this.config.customSocketFactory(socketConfig)
        : makeWASocket(socketConfig as any);

      this.sock = sock;

      // Bind Baileys credential saving
      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          this.emit('creds.update');
        } catch (err) {
          this.logger.error({ err }, 'Failed to save WhatsApp auth credentials');
        }
      });

      // Bind connection state changes
      sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        this.handleConnectionUpdate(update);
      });

      // Forward inbound message upserts
      sock.ev.on('messages.upsert', (data) => {
        this.emit('messages.upsert', data);
      });

      return sock;
    } catch (err) {
      this.logger.error({ err }, 'Error during WhatsApp socket initialization');
      this.handleConnectionFailure(err);
      throw err;
    }
  }

  /**
   * Gracefully closes the active connection and cancels any scheduled reconnects.
   */
  public async disconnect(): Promise<void> {
    this.isExplicitDisconnect = true;
    this.clearReconnectTimer();

    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (err) {
        this.logger.warn({ err }, 'Socket end threw an error during graceful shutdown');
      }
      this.sock = null;
    }

    this.setStatus('DISCONNECTED');
  }

  /**
   * Internal handler for Baileys connection.update events.
   */
  public handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.emit('qr', qr);
    }

    if (connection === 'open') {
      this.retryCount = 0;
      this.clearReconnectTimer();
      this.setStatus('CONNECTED');
      this.logger.info('WhatsApp connection successfully established');
      this.emit('connected');
    } else if (connection === 'close') {
      this.handleConnectionClose(lastDisconnect);
    }

    this.emit('connection.update', update);
  }

  /**
   * Internal logic for handling socket closures and anti-ban exponential reconnects.
   */
  private handleConnectionClose(lastDisconnect?: { error?: Error | undefined; date?: Date | undefined }): void {
    if (this.isExplicitDisconnect) {
      this.logger.info('Connection closed as part of explicit shutdown');
      return;
    }

    const error = lastDisconnect?.error;
    const statusCode =
      (error as any)?.output?.statusCode ??
      (error as any)?.statusCode;

    this.logger.warn(
      { statusCode, err: error?.message },
      'WhatsApp connection closed'
    );

    // If logged out (401), NEVER attempt reconnecting (prevents account ban / spamming)
    if (statusCode === DisconnectReason.loggedOut) {
      this.setStatus('LOGGED_OUT');
      this.logger.error('WhatsApp session is logged out. Manual re-authentication required.');
      this.emit('logged_out', error);
      return;
    }

    this.setStatus('DISCONNECTED');
    this.scheduleReconnect(statusCode === DisconnectReason.restartRequired);
  }

  private handleConnectionFailure(_err: unknown): void {
    if (this.isExplicitDisconnect) return;
    this.setStatus('DISCONNECTED');
    this.scheduleReconnect(false);
  }

  /**
   * Schedules a reconnection attempt using exponential backoff with jitter.
   */
  public scheduleReconnect(immediate = false): void {
    if (this.isExplicitDisconnect || this.status === 'LOGGED_OUT') {
      return;
    }

    this.clearReconnectTimer();

    if (this.retryCount >= this.config.maxRetries) {
      this.logger.error(
        { retryCount: this.retryCount, maxRetries: this.config.maxRetries },
        'Max reconnection attempts reached. Halting auto-reconnect.'
      );
      this.emit('max_retries_reached', { retryCount: this.retryCount });
      return;
    }

    let delayMs = 0;
    if (!immediate) {
      const exponential = this.config.reconnectBaseDelayMs * Math.pow(2, this.retryCount);
      const jitter = Math.floor(Math.random() * 500); // 0-500ms jitter
      delayMs = Math.min(exponential + jitter, this.config.reconnectMaxDelayMs);
    }

    this.setStatus('RECONNECTING');
    this.logger.info(
      { attempt: this.retryCount + 1, delayMs },
      'Scheduling WhatsApp reconnect'
    );

    this.reconnectTimer = setTimeout(async () => {
      this.retryCount += 1;
      try {
        await this.connect();
      } catch (err) {
        this.logger.error({ err }, 'Reconnection attempt failed');
      }
    }, delayMs);
  }

  private setStatus(status: ConnectionStatus): void {
    const prev = this.status;
    this.status = status;
    if (prev !== status) {
      this.emit('status_change', { from: prev, to: status });
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
