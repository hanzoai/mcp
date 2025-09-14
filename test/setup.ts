/**
 * Jest test setup file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

// Global test timeout
jest.setTimeout(10000);

// Test fixtures directory
export const TEST_FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const TEST_TEMP_DIR = path.join(__dirname, 'temp');

// Create test directories
beforeAll(async () => {
  try {
    await fs.mkdir(TEST_FIXTURES_DIR, { recursive: true });
    await fs.mkdir(TEST_TEMP_DIR, { recursive: true });
  } catch (error) {
    // Directories might already exist
  }
});

// Clean up temp directory after all tests
afterAll(async () => {
  try {
    await fs.rm(TEST_TEMP_DIR, { recursive: true, force: true });
  } catch (error) {
    // Directory might not exist
  }
});

// Mock console methods to reduce test noise
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  // Mock console.error and console.warn unless we're specifically testing them
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterEach(() => {
  // Restore console methods
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  
  // Clear all mocks
  jest.clearAllMocks();
});

// Helper to create test files
export async function createTestFile(relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(TEST_TEMP_DIR, relativePath);
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}

// Helper to read test file
export async function readTestFile(relativePath: string): Promise<string> {
  const fullPath = path.join(TEST_TEMP_DIR, relativePath);
  return fs.readFile(fullPath, 'utf8');
}

// Helper to check if test file exists
export async function testFileExists(relativePath: string): Promise<boolean> {
  try {
    const fullPath = path.join(TEST_TEMP_DIR, relativePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

// Helper to cleanup test files
export async function cleanupTestFile(relativePath: string): Promise<void> {
  try {
    const fullPath = path.join(TEST_TEMP_DIR, relativePath);
    await fs.rm(fullPath, { force: true });
  } catch {
    // File might not exist
  }
}