/**
 * Flash Peak TMS - Outbound WhatsApp Message Sender
 * 
 * Enforces rate limiting, anti-spam pacing intervals, and progressive reveals.
 */

import { randomUUID } from 'node:crypto';
import type { WASocket, proto } from '@whiskeysockets/baileys';
import type { SendOptions } from './types.js';
import pino from 'pino';

export interface WhatsAppSenderConfig {
  minIntervalMs?: number; // Minimum wait between successive outbound messages (anti-ban)
  revealDelayMs?: number; // Default delay between progressive reveal messages
  logLevel?: pino.LevelWithSilent;
}

interface QueuedTask<T> {
  id: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
}

export class WhatsAppSender {
  private socketProvider: () => WASocket | null;
  private minIntervalMs: number;
  private revealDelayMs: number;
  private lastSentAt = 0;
  private queue: QueuedTask<any>[] = [];
  private isProcessingQueue = false;
  private logger: pino.Logger;

  constructor(
    socketProvider: () => WASocket | null,
    config?: WhatsAppSenderConfig
  ) {
    this.socketProvider = socketProvider;
    this.minIntervalMs = config?.minIntervalMs ?? 1500;
    this.revealDelayMs = config?.revealDelayMs ?? 2500;
    this.logger = pino({ level: config?.logLevel || 'silent' });
  }

  /**
   * Enqueues a message send action to be dispatched subject to rate limiting.
   */
  private enqueue<T>(taskFn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: randomUUID(),
        execute: taskFn,
        resolve,
        reject,
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      const now = Date.now();
      const elapsed = now - this.lastSentAt;
      if (elapsed < this.minIntervalMs) {
        const waitMs = this.minIntervalMs - elapsed;
        await new Promise((r) => setTimeout(r, waitMs));
      }

      try {
        const result = await task.execute();
        this.lastSentAt = Date.now();
        task.resolve(result);
      } catch (err) {
        this.logger.error({ err, taskId: task.id }, 'Outbound message sending failed');
        task.reject(err);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Sends a standard text message.
   */
  public async sendText(
    chatId: string,
    text: string,
    options?: SendOptions
  ): Promise<string> {
    return this.enqueue(async () => {
      const sock = this.socketProvider();
      if (!sock) {
        throw new Error('WhatsApp socket is not connected');
      }

      const content: Record<string, any> = { text };
      if (options?.mentions && options.mentions.length > 0) {
        content.mentions = options.mentions;
      }

      const sendOptions: Record<string, any> = {};
      if (options?.quoted) {
        sendOptions.quoted = options.quoted;
      }
      if (options?.ephemeralExpiration) {
        sendOptions.ephemeralExpiration = options.ephemeralExpiration;
      }

      const res = await sock.sendMessage(chatId, content as any, sendOptions);
      return res?.key?.id || randomUUID();
    });
  }

  /**
   * Sends a text message quoting a specific previous message.
   */
  public async sendQuote(
    chatId: string,
    text: string,
    quoted: proto.IWebMessageInfo | { key: proto.IMessageKey },
    options?: SendOptions
  ): Promise<string> {
    return this.sendText(chatId, text, {
      ...options,
      quoted,
    });
  }

  /**
   * Paced progressive reveal sender for tournament draw.
   * Sends items sequentially with a configurable pacing interval (e.g. 2-3s).
   */
  public async sendProgressiveReveal(
    chatId: string,
    items: Array<{ text: string; delayMs?: number }>,
    onProgress?: (index: number) => void
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;

      await this.sendText(chatId, item.text);
      if (onProgress) {
        onProgress(i);
      }

      // Add pacing delay between reveal steps
      const delay = item.delayMs ?? this.revealDelayMs;
      if (i < items.length - 1 && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Returns current pending queue length (useful for metrics and testing).
   */
  public getQueueLength(): number {
    return this.queue.length;
  }
}
