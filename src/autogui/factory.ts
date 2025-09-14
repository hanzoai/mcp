/**
 * AutoGUI Factory
 * Manages adapter selection, initialization, and fallback strategies
 */

import {
  AutoGUIAdapter,
  AutoGUIFactory,
  AutoGUIConfig,
  AutoGUIError,
  AutoGUINotAvailableError
} from './types.js';
import { RustAutoGUIAdapter } from './adapters/rust.js';
import { JSAutoGUIAdapter } from './adapters/jsautogui.js';
import { PyAutoGUIAdapter } from './adapters/pyautogui.js';

export class HanzoAutoGUIFactory implements AutoGUIFactory {
  private static instance: HanzoAutoGUIFactory | null = null;
  private adapters: Map<string, typeof RustAutoGUIAdapter | typeof JSAutoGUIAdapter | typeof PyAutoGUIAdapter> = new Map();
  private cachedAvailability: Map<string, boolean> = new Map();
  private detectedBest: string | null = null;

  constructor() {
    this.registerAdapters();
  }

  static getInstance(): HanzoAutoGUIFactory {
    if (!HanzoAutoGUIFactory.instance) {
      HanzoAutoGUIFactory.instance = new HanzoAutoGUIFactory();
    }
    return HanzoAutoGUIFactory.instance;
  }

  private registerAdapters(): void {
    this.adapters.set('rust', RustAutoGUIAdapter);
    this.adapters.set('js', JSAutoGUIAdapter);
    this.adapters.set('python', PyAutoGUIAdapter);
  }

  async createAdapter(implementation?: string, config?: Partial<AutoGUIConfig>): Promise<AutoGUIAdapter> {
    // Determine which implementation to use
    let targetImplementation = implementation;
    
    if (!targetImplementation || targetImplementation === 'auto') {
      targetImplementation = await this.detectBestImplementation();
    }

    const AdapterClass = this.adapters.get(targetImplementation);
    if (!AdapterClass) {
      throw new AutoGUIError(`Unknown AutoGUI implementation: ${targetImplementation}`);
    }

    try {
      const adapter = new AdapterClass(config);
      await adapter.configure({ implementation: targetImplementation, ...config });
      
      this.log(`Successfully created ${targetImplementation} adapter`);
      return adapter;
    } catch (error) {
      this.log(`Failed to create ${targetImplementation} adapter: ${error}`);
      
      // Try fallback if auto mode
      if (implementation === 'auto' || !implementation) {
        return this.createWithFallback(config, [targetImplementation]);
      }
      
      throw error;
    }
  }

  private async createWithFallback(config?: Partial<AutoGUIConfig>, excludeImplementations: string[] = []): Promise<AutoGUIAdapter> {
    const fallbackOrder = config?.fallbackOrder || ['rust', 'js', 'python'];
    const availableImplementations = fallbackOrder.filter(impl => !excludeImplementations.includes(impl));

    for (const implementation of availableImplementations) {
      try {
        this.log(`Trying fallback implementation: ${implementation}`);
        const adapter = await this.createAdapter(implementation, config);
        this.log(`Fallback successful: using ${implementation} adapter`);
        return adapter;
      } catch (error) {
        this.log(`Fallback ${implementation} failed: ${error}`);
        continue;
      }
    }

    throw new AutoGUINotAvailableError('all', new Error('No AutoGUI implementation available'));
  }

  async getAvailableImplementations(): Promise<string[]> {
    const available: string[] = [];
    
    for (const [name, AdapterClass] of this.adapters) {
      if (this.cachedAvailability.has(name)) {
        if (this.cachedAvailability.get(name)) {
          available.push(name);
        }
        continue;
      }

      try {
        const adapter = new AdapterClass();
        const isAvailable = await adapter.isAvailable();
        this.cachedAvailability.set(name, isAvailable);
        
        if (isAvailable) {
          available.push(name);
        }
      } catch {
        this.cachedAvailability.set(name, false);
      }
    }

    return available;
  }

  async detectBestImplementation(): Promise<string> {
    if (this.detectedBest) {
      return this.detectedBest;
    }

    const available = await this.getAvailableImplementations();
    
    if (available.length === 0) {
      throw new AutoGUINotAvailableError('all', new Error('No AutoGUI implementations available'));
    }

    // Priority order: RustAutoGUI (fastest) > JSAutoGUI (native Node.js) > PyAutoGUI (subprocess)
    const priorityOrder = ['rust', 'js', 'python'];
    
    for (const preferred of priorityOrder) {
      if (available.includes(preferred)) {
        this.detectedBest = preferred;
        this.log(`Detected best implementation: ${preferred}`);
        return preferred;
      }
    }

    // Fallback to first available
    this.detectedBest = available[0];
    this.log(`Using first available implementation: ${this.detectedBest}`);
    return this.detectedBest;
  }

  /**
   * Clear cached availability and best implementation detection
   * Useful for testing or when environment changes
   */
  clearCache(): void {
    this.cachedAvailability.clear();
    this.detectedBest = null;
  }

  /**
   * Test all implementations and return detailed status
   */
  async getImplementationStatus(): Promise<Record<string, { available: boolean; version?: string; error?: string }>> {
    const status: Record<string, { available: boolean; version?: string; error?: string }> = {};

    for (const [name, AdapterClass] of this.adapters) {
      try {
        const adapter = new AdapterClass();
        const isAvailable = await adapter.isAvailable();
        
        if (isAvailable) {
          try {
            const version = await adapter.getImplementationVersion();
            status[name] = { available: true, version };
          } catch {
            status[name] = { available: true, version: 'unknown' };
          }
        } else {
          status[name] = { available: false, error: 'Not available' };
        }
      } catch (error: any) {
        status[name] = { available: false, error: error.message || 'Unknown error' };
      }
    }

    return status;
  }

  private log(message: string): void {
    console.error(`[AutoGUI Factory] ${message}`);
  }
}

/**
 * Convenience function to create an AutoGUI adapter
 */
export async function createAutoGUI(implementation?: string, config?: Partial<AutoGUIConfig>): Promise<AutoGUIAdapter> {
  const factory = HanzoAutoGUIFactory.getInstance();
  return factory.createAdapter(implementation, config);
}

/**
 * Convenience function to get available implementations
 */
export async function getAvailableAutoGUIImplementations(): Promise<string[]> {
  const factory = HanzoAutoGUIFactory.getInstance();
  return factory.getAvailableImplementations();
}

/**
 * Convenience function to detect the best implementation
 */
export async function detectBestAutoGUIImplementation(): Promise<string> {
  const factory = HanzoAutoGUIFactory.getInstance();
  return factory.detectBestImplementation();
}

/**
 * Convenience function to get implementation status
 */
export async function getAutoGUIImplementationStatus(): Promise<Record<string, { available: boolean; version?: string; error?: string }>> {
  const factory = HanzoAutoGUIFactory.getInstance();
  return factory.getImplementationStatus();
}