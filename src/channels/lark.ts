import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface LarkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LarkChannel implements Channel {
  name = 'lark';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: LarkChannelOpts;
  private appId: string;
  private appSecret: string;
  private encryptKey?: string;

  constructor(
    config: {
      appId: string;
      appSecret: string;
      encryptKey?: string;
    },
    opts: LarkChannelOpts,
  ) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.encryptKey = config.encryptKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Create Lark client for sending messages
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
    });

    // Create WebSocket client for receiving events
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.debug,
      logger: {
        error: (...msg: any[]) =>
          logger.error({ larkSDK: true }, msg.join(' ')),
        warn: (...msg: any[]) => logger.warn({ larkSDK: true }, msg.join(' ')),
        info: (...msg: any[]) => logger.info({ larkSDK: true }, msg.join(' ')),
        debug: (...msg: any[]) =>
          logger.debug({ larkSDK: true }, msg.join(' ')),
        trace: (...msg: any[]) =>
          logger.trace({ larkSDK: true }, msg.join(' ')),
      },
    });

    // Create event dispatcher to handle incoming messages
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.encryptKey,
    }).register({
      'im.message.receive_v1': async (data) => {
        logger.info(
          {
            eventType: 'im.message.receive_v1',
            chatId: data?.message?.chat_id,
          },
          'Lark message event received',
        );
        await this.handleMessageEvent(data);
      },
    });

    // Also register a catch-all handler for debugging
    const originalInvoke = (eventDispatcher as any).invoke?.bind(
      eventDispatcher,
    );
    if (originalInvoke) {
      (eventDispatcher as any).invoke = async (data: any) => {
        logger.debug(
          { eventType: data?.header?.event_type, schema: data?.schema },
          'Lark raw event',
        );
        return originalInvoke(data);
      };
    }

    // Start WebSocket connection
    await this.wsClient.start({ eventDispatcher });

    logger.info('Lark channel connected via WebSocket');
  }

  /**
   * Handle incoming message event from Lark WebSocket.
   */
  private async handleMessageEvent(data: any): Promise<void> {
    try {
      // Check if this is a text message
      if (data.message?.message_type !== 'text') {
        return;
      }

      const message = data.message;
      const chatId = message.chat_id;
      const chatJid = `lark:${chatId}`;

      // Parse message content (JSON string containing text)
      let content: string;
      try {
        const contentObj = JSON.parse(message.content || '{}');
        content = contentObj.text || '';
      } catch {
        content = message.content || '';
      }

      const timestamp = new Date(
        parseInt(message.create_time) || Date.now(),
      ).toISOString();

      // Get sender info
      const sender = message.sender?.sender_id?.open_id || '';
      const senderName =
        data.sender?.sender_info?.nickname ||
        message.sender?.sender_id?.union_id ||
        sender.slice(0, 8) ||
        'Unknown';

      const msgId = message.message_id;

      // Get chat info
      const chatInfo = message.chat_info;
      const chatName = chatInfo?.name || chatJid;
      const isGroup =
        chatInfo?.chat_type === 'group' || message.chat_type === 'group';

      // Handle @mention conversion for group chats
      // Lark mentions are in format <at id="user_id">name</at>
      const mentionPattern = /<at[^>]*>(.*?)<\/at>/g;
      const botMentioned = content.includes('<at id="');

      // Convert Lark mentions to trigger pattern format
      let processedContent = content.replace(
        mentionPattern,
        (match: string, _name: string) => {
          const idMatch = match.match(/id="([^"]+)"/);
          if (idMatch && idMatch[1]) {
            return `@${idMatch[1]}`;
          }
          return match;
        },
      );

      logger.info(
        { chatJid, sender: senderName, content: processedContent, isGroup },
        'Received Lark message via WebSocket',
      );

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'lark', isGroup);
      logger.info({ chatJid }, 'Lark chat metadata stored');

      // If bot is mentioned but no trigger pattern, prepend it
      if (botMentioned && !TRIGGER_PATTERN.test(processedContent)) {
        processedContent = `@${ASSISTANT_NAME} ${processedContent}`;
      }

      // Deliver the message
      logger.info(
        { chatJid, content: processedContent },
        'Delivering Lark message to router',
      );
      try {
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: processedContent,
          timestamp,
        });
        logger.info({ chatJid }, 'Lark message delivered successfully');
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to deliver Lark message');
      }
    } catch (err) {
      logger.error({ err, data }, 'Error handling Lark message event');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Lark channel not connected');
    }

    const chatId = jid.replace(/^lark:/, '');

    try {
      // Determine chat ID type (open_chat_id or open_id for p2p)
      const receiveIdType = chatId.includes('@') ? 'email' : 'chat_id';

      const response = await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType as any,
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      if (response.code !== 0) {
        throw new Error(
          `Lark API error: ${response.msg} (code: ${response.code})`,
        );
      }

      logger.info(
        { chatId, messageId: response.data?.message_id },
        'Lark message sent',
      );
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send Lark message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null && this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient doesn't have explicit stop method, but we can clean up the reference
      this.wsClient = null;
    }
    this.client = null;
    logger.info('Lark channel disconnected');
  }
}

// Self-registration with the channel registry
registerChannel('lark', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'LARK_APP_ID',
    'LARK_APP_SECRET',
    'LARK_ENCRYPT_KEY',
  ]);
  const appId = process.env.LARK_APP_ID || envVars.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET || envVars.LARK_APP_SECRET;
  const encryptKey = process.env.LARK_ENCRYPT_KEY || envVars.LARK_ENCRYPT_KEY;

  if (!appId || !appSecret) {
    logger.debug(
      'LARK_APP_ID or LARK_APP_SECRET not set, skipping Lark channel',
    );
    return null;
  }

  return new LarkChannel(
    {
      appId,
      appSecret,
      encryptKey,
    },
    opts,
  );
});
