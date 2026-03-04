import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// Mock the logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock the registry
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jane',
  TRIGGER_PATTERN: /^@Jane\b/,
}));

// Create mock implementations
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockCreate = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'msg_123' } });
const mockRegister = vi.fn().mockReturnThis();

// Mock lark SDK with proper constructors
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    im = {
      message: {
        create: mockCreate,
      },
    };
  },
  WSClient: class MockWSClient {
    start = mockStart;
  },
  EventDispatcher: class MockEventDispatcher {
    register = mockRegister;
  },
  AppType: {
    SelfBuild: 0,
  },
}));

// Import after mocks
const { LarkChannel } = await import('./lark.js');

describe('LarkChannel', () => {
  const mockOnMessage = vi.fn() as unknown as Mock<OnInboundMessage>;
  const mockOnChatMetadata = vi.fn() as unknown as Mock<OnChatMetadata>;
  const mockRegisteredGroups = vi.fn().mockReturnValue({}) as unknown as () => Record<string, RegisteredGroup>;

  const defaultConfig = {
    appId: 'test_app_id',
    appSecret: 'test_app_secret',
    encryptKey: 'test_encrypt_key',
  };

  const defaultOpts = {
    onMessage: mockOnMessage,
    onChatMetadata: mockOnChatMetadata,
    registeredGroups: mockRegisteredGroups,
  };

  let channel: InstanceType<typeof LarkChannel>;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new LarkChannel(defaultConfig, defaultOpts);
  });

  afterEach(async () => {
    try {
      await channel.disconnect();
    } catch {
      // Ignore disconnect errors in cleanup
    }
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(channel.name).toBe('lark');
      expect(channel.isConnected()).toBe(false);
    });

    it('should work without optional config', () => {
      const minimalChannel = new LarkChannel(
        { appId: 'test_app_id', appSecret: 'test_app_secret' },
        defaultOpts,
      );
      expect(minimalChannel.name).toBe('lark');
    });
  });

  describe('connect', () => {
    it('should connect successfully and initialize WebSocket', async () => {
      await channel.connect();

      expect(mockStart).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe('ownsJid', () => {
    it('should return true for lark: prefixed JIDs', () => {
      expect(channel.ownsJid('lark:oc_123456')).toBe(true);
      expect(channel.ownsJid('lark:user@example.com')).toBe(true);
    });

    it('should return false for non-lark JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
      expect(channel.ownsJid('whatsapp:123456')).toBe(false);
      expect(channel.ownsJid('slack:C123456')).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should throw if not connected', async () => {
      await expect(channel.sendMessage('lark:test', 'Hello')).rejects.toThrow(
        'Lark channel not connected',
      );
    });

    it('should send message when connected', async () => {
      await channel.connect();

      await channel.sendMessage('lark:oc_123456', 'Hello World');

      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should disconnect gracefully', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await expect(channel.disconnect()).resolves.not.toThrow();
    });
  });
});
