#!/usr/bin/env node

/**
 * Hanzo MCP Server Entry Point
 * This file serves as a simple entry point for running the MCP server
 */

import('./dist/cli.js').catch(err => {
  console.error('Failed to start Hanzo MCP server:', err);
  process.exit(1);
});