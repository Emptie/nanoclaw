#!/usr/bin/env node
/**
 * Obsidian CLI HTTP Proxy
 * Runs on host (macOS) to allow container agents to use Obsidian CLI
 *
 * Usage:
 *   node obsidian-proxy.js [port]
 *
 * Environment:
 *   OBSIDIAN_PROXY_PORT - Default port (default: 9955)
 *   OBSIDIAN_PROXY_TOKEN - Optional auth token
 */

const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

const PORT = process.argv[2] || process.env.OBSIDIAN_PROXY_PORT || 9955;
const TOKEN = process.env.OBSIDIAN_PROXY_TOKEN;
const OBSIDIAN_BIN = '/Applications/Obsidian.app/Contents/MacOS/obsidian';

// Ensure log directory exists
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...meta };
  console.log(JSON.stringify(entry));

  // Also write to file
  const logFile = path.join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

async function executeObsidian(args) {
  const cmd = `${OBSIDIAN_BIN} ${args}`;
  log('info', 'Executing Obsidian CLI', { command: cmd });

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    if (stderr && !stderr.includes('Loading updated app package') && !stderr.includes('installer is out of date')) {
      log('warn', 'Obsidian CLI stderr', { stderr });
    }

    return { success: true, output: stdout, error: null };
  } catch (error) {
    log('error', 'Obsidian CLI execution failed', { error: error.message });
    return { success: false, output: error.stdout || '', error: error.message };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Auth check
  if (TOKEN) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // Parse body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { command, args = '' } = JSON.parse(body);

      if (!command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing command' }));
        return;
      }

      // Security: only allow specific Obsidian commands
      const allowedCommands = [
        // Vault & file operations
        'vaults', 'vault', 'files', 'file', 'folders', 'folder',
        'read', 'create', 'append', 'prepend', 'delete', 'move', 'rename',
        // Search & navigation
        'search', 'search:context', 'tags', 'tag', 'properties', 'property:read', 'property:set', 'property:remove',
        'tasks', 'task', 'daily', 'daily:read', 'daily:append', 'daily:prepend', 'daily:path',
        'bookmarks', 'bookmark', 'links', 'backlinks', 'outlines', 'outline',
        'templates', 'template:read', 'template:insert', 'recents', 'random', 'random:read',
        'orphans', 'deadends', 'unresolved', 'aliases', 'history', 'history:list', 'history:read', 'history:open', 'history:restore', 'wordcount',
        // Plugin development
        'plugins', 'plugin', 'plugin:enable', 'plugin:disable', 'plugin:install', 'plugin:uninstall', 'plugin:reload',
        'dev:errors', 'dev:screenshot', 'dev:dom', 'dev:console', 'dev:css', 'dev:mobile', 'dev:cdp', 'dev:debug',
        // JavaScript execution
        'eval',
        // Additional utilities
        'commands', 'command', 'hotkeys', 'hotkey', 'sync', 'sync:status', 'sync:history', 'sync:open', 'sync:read', 'sync:restore',
        'snippets', 'snippet:enable', 'snippet:disable', 'themes', 'theme', 'theme:set', 'theme:install', 'theme:uninstall',
        'open', 'close', 'reload', 'restart', 'version', 'vault'
      ];

      const baseCommand = command.split(' ')[0].split(':')[0];
      if (!allowedCommands.includes(command.split(' ')[0]) && !allowedCommands.includes(baseCommand)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Command '${command}' not allowed` }));
        return;
      }

      log('info', 'Received request', { command, args });

      const fullArgs = `${command} ${args}`.trim();
      const result = await executeObsidian(fullArgs);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      log('error', 'Request processing failed', { error: error.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `Obsidian CLI Proxy started`, { port: PORT, pid: process.pid });
  console.log(`\nObsidian CLI Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`Press Ctrl+C to stop\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Shutting down gracefully');
  server.close(() => { process.exit(0); });
});

process.on('SIGINT', () => {
  log('info', 'Shutting down (SIGINT)');
  server.close(() => { process.exit(0); });
});
