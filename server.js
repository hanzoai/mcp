#!/usr/bin/env node

/**
 * Hanzo MCP Server Entry Point
 * Starts the MCP server directly when executed
 */

// Add 'serve' to process.argv if no command is specified
// This makes the server start by default
if (!process.argv.slice(2).some(arg => ['serve', 'install', 'install-desktop', 'list-tools', '--version', '--help', '-V', '-h'].includes(arg))) {
  process.argv.push('serve');
}

import('./dist/cli.js').catch(err => {
  console.error('Failed to start Hanzo MCP server:', err);
  process.exit(1);
});