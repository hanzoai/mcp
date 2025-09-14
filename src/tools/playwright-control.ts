/**
 * Playwright Control for Hanzo Desktop App
 * 
 * Provides high-level automation capabilities using Playwright to control
 * the Hanzo Desktop application through Chrome DevTools Protocol compatibility.
 */

import { Tool } from '../types';

interface PlaywrightAction {
  type: 'click' | 'type' | 'wait' | 'screenshot' | 'evaluate' | 'navigate' | 'waitForSelector';
  selector?: string;
  text?: string;
  timeout?: number;
  script?: string;
  url?: string;
}

interface AutomationSequence {
  name: string;
  description: string;
  actions: PlaywrightAction[];
}

export class PlaywrightControlTool implements Tool {
  name = 'playwright_control';
  description = 'High-level automation control for Hanzo Desktop app using Playwright-compatible methods';
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'connect',
          'disconnect',
          'click',
          'type',
          'wait',
          'waitForSelector',
          'screenshot',
          'evaluate',
          'getTitle',
          'getText',
          'runSequence',
          'createSequence',
          'listSequences',
          'status'
        ],
        description: 'Playwright automation action to perform'
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element targeting'
      },
      text: {
        type: 'string',
        description: 'Text to type or search for'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 5000)'
      },
      script: {
        type: 'string',
        description: 'JavaScript code to evaluate in the page'
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (for internal app navigation)'
      },
      sequence: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['click', 'type', 'wait', 'screenshot', 'evaluate', 'navigate', 'waitForSelector'] },
                selector: { type: 'string' },
                text: { type: 'string' },
                timeout: { type: 'number' },
                script: { type: 'string' },
                url: { type: 'string' }
              },
              required: ['type']
            }
          }
        },
        description: 'Automation sequence definition'
      },
      sequenceName: {
        type: 'string',
        description: 'Name of sequence to run'
      },
      debugPort: {
        type: 'number',
        description: 'Chrome DevTools Protocol port (default: 9222)'
      }
    },
    required: ['action']
  };

  private connected = false;
  private debugPort = 9222;
  private sequences: Map<string, AutomationSequence> = new Map();

  constructor() {
    // Initialize with some common sequences
    this.initializeCommonSequences();
  }

  async handler(params: any): Promise<any> {
    return this.execute(params);
  }

  async execute(params: any): Promise<any> {
    const { 
      action, 
      selector, 
      text, 
      timeout = 5000, 
      script, 
      url, 
      sequence, 
      sequenceName,
      debugPort = 9222
    } = params;

    this.debugPort = debugPort;

    switch (action) {
      case 'connect':
        return this.connect();
      
      case 'disconnect':
        return this.disconnect();
      
      case 'status':
        return this.getStatus();
      
      case 'click':
        return this.click(selector);
      
      case 'type':
        return this.type(selector, text);
      
      case 'wait':
        return this.wait(timeout);
      
      case 'waitForSelector':
        return this.waitForSelector(selector, timeout);
      
      case 'screenshot':
        return this.screenshot();
      
      case 'evaluate':
        return this.evaluate(script);
      
      case 'getTitle':
        return this.getTitle();
      
      case 'getText':
        return this.getText(selector);
      
      case 'runSequence':
        return this.runSequence(sequenceName);
      
      case 'createSequence':
        return this.createSequence(sequence);
      
      case 'listSequences':
        return this.listSequences();
      
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  private async connect(): Promise<any> {
    try {
      // Test connection to MCP server
      const response = await this.sendCDPCommand('Runtime.enable');
      if (response.success) {
        this.connected = true;
        return {
          success: true,
          message: `Connected to Hanzo Desktop app on port ${this.debugPort}`,
          port: this.debugPort,
          capabilities: [
            'JavaScript evaluation',
            'DOM manipulation',
            'Element clicking',
            'Screenshot capture',
            'Page navigation',
            'Automation sequences'
          ]
        };
      } else {
        return {
          success: false,
          message: 'Failed to connect to Hanzo Desktop app',
          hint: 'Ensure the app is running with MCP server enabled'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: 'Connection failed',
        error: (error as any).message,
        hint: 'Start Hanzo Desktop app and ensure MCP server is running'
      };
    }
  }

  private async disconnect(): Promise<any> {
    this.connected = false;
    return {
      success: true,
      message: 'Disconnected from Hanzo Desktop app'
    };
  }

  private async getStatus(): Promise<any> {
    return {
      connected: this.connected,
      port: this.debugPort,
      sequencesAvailable: this.sequences.size,
      capabilities: this.connected ? [
        'Runtime evaluation',
        'DOM queries', 
        'Input simulation',
        'Screenshot capture'
      ] : []
    };
  }

  private async click(selector: string): Promise<any> {
    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    const result = await this.sendCDPCommand('hanzo.clickElement', {
      selector,
      window: 'main'
    });

    return {
      success: result.success,
      message: result.success ? `Clicked element: ${selector}` : `Failed to click: ${selector}`,
      selector,
      result: result.data
    };
  }

  private async type(selector: string, text: string): Promise<any> {
    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    // First focus the element, then send the text
    const script = `
      const element = document.querySelector('${selector}');
      if (element) {
        element.focus();
        element.value = '${text.replace(/'/g, "\\'")}';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, typed: '${text}' };
      } else {
        return { success: false, error: 'Element not found' };
      }
    `;

    const result = await this.sendCDPCommand('hanzo.executeJS', {
      script,
      window: 'main'
    });

    return {
      success: result.success,
      message: result.success ? `Typed text into ${selector}` : `Failed to type into ${selector}`,
      selector,
      text,
      result: result.data
    };
  }

  private async wait(timeout: number): Promise<any> {
    await new Promise(resolve => setTimeout(resolve, timeout));
    return {
      success: true,
      message: `Waited ${timeout}ms`
    };
  }

  private async waitForSelector(selector: string, timeout: number = 5000): Promise<any> {
    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    const script = `
      const waitForElement = (selector, timeout) => {
        return new Promise((resolve) => {
          const element = document.querySelector(selector);
          if (element) {
            resolve({ success: true, found: true });
            return;
          }

          const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
              observer.disconnect();
              resolve({ success: true, found: true });
            }
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true
          });

          setTimeout(() => {
            observer.disconnect();
            resolve({ success: false, found: false, timeout: true });
          }, timeout);
        });
      };

      waitForElement('${selector}', ${timeout});
    `;

    const result = await this.sendCDPCommand('hanzo.executeJS', {
      script,
      window: 'main'
    });

    return {
      success: result.success,
      message: result.success ? `Found element: ${selector}` : `Element not found: ${selector}`,
      selector,
      timeout,
      result: result.data
    };
  }

  private async screenshot(): Promise<any> {
    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    const result = await this.sendCDPCommand('Page.captureScreenshot', {
      format: 'png',
      quality: 90
    });

    return {
      success: result.success,
      message: result.success ? 'Screenshot captured' : 'Failed to capture screenshot',
      data: result.data
    };
  }

  private async evaluate(script: string): Promise<any> {
    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    const result = await this.sendCDPCommand('hanzo.executeJS', {
      script,
      window: 'main'
    });

    return {
      success: result.success,
      message: result.success ? 'Script executed' : 'Script execution failed',
      script,
      result: result.data
    };
  }

  private async getTitle(): Promise<any> {
    return this.evaluate('return document.title');
  }

  private async getText(selector: string): Promise<any> {
    const script = `
      const element = document.querySelector('${selector}');
      return element ? element.textContent : null;
    `;
    return this.evaluate(script);
  }

  private async runSequence(sequenceName: string): Promise<any> {
    const sequence = this.sequences.get(sequenceName);
    if (!sequence) {
      return {
        success: false,
        message: `Sequence '${sequenceName}' not found`,
        availableSequences: Array.from(this.sequences.keys())
      };
    }

    if (!this.connected) {
      return { success: false, message: 'Not connected - call connect() first' };
    }

    const results = [];
    for (let i = 0; i < sequence.actions.length; i++) {
      const action = sequence.actions[i];
      let result;

      try {
        switch (action.type) {
          case 'click':
            result = await this.click(action.selector!);
            break;
          case 'type':
            result = await this.type(action.selector!, action.text!);
            break;
          case 'wait':
            result = await this.wait(action.timeout || 1000);
            break;
          case 'waitForSelector':
            result = await this.waitForSelector(action.selector!, action.timeout);
            break;
          case 'screenshot':
            result = await this.screenshot();
            break;
          case 'evaluate':
            result = await this.evaluate(action.script!);
            break;
          default:
            result = { success: false, message: `Unknown action type: ${action.type}` };
        }

        results.push({ step: i + 1, action: action.type, result });

        // Stop if any step fails (unless it's a wait or screenshot)
        if (!result.success && !['wait', 'screenshot'].includes(action.type)) {
          return {
            success: false,
            message: `Sequence failed at step ${i + 1}`,
            sequence: sequenceName,
            results
          };
        }
      } catch (error: any) {
        results.push({ step: i + 1, action: action.type, error: error.message });
        return {
          success: false,
          message: `Sequence error at step ${i + 1}`,
          sequence: sequenceName,
          results
        };
      }
    }

    return {
      success: true,
      message: `Sequence '${sequenceName}' completed successfully`,
      sequence: sequenceName,
      results
    };
  }

  private async createSequence(sequenceData: any): Promise<any> {
    if (!sequenceData.name || !sequenceData.actions) {
      return {
        success: false,
        message: 'Sequence must have name and actions'
      };
    }

    this.sequences.set(sequenceData.name, sequenceData);
    return {
      success: true,
      message: `Sequence '${sequenceData.name}' created`,
      sequence: sequenceData
    };
  }

  private async listSequences(): Promise<any> {
    const sequences = Array.from(this.sequences.entries()).map(([name, seq]) => ({
      name,
      description: seq.description,
      steps: seq.actions.length
    }));

    return {
      success: true,
      sequences,
      count: sequences.length
    };
  }

  private initializeCommonSequences(): void {
    // Click Get Started button sequence
    this.sequences.set('click_get_started', {
      name: 'click_get_started',
      description: 'Click the Get Started button in Hanzo AI app',
      actions: [
        { type: 'waitForSelector', selector: 'button:contains("Get Started")', timeout: 5000 },
        { type: 'click', selector: 'button:contains("Get Started")' },
        { type: 'wait', timeout: 2000 },
        { type: 'screenshot' }
      ]
    });

    // Basic app exploration
    this.sequences.set('explore_app', {
      name: 'explore_app',
      description: 'Take screenshots and explore the main areas of the app',
      actions: [
        { type: 'screenshot' },
        { type: 'evaluate', script: 'return { title: document.title, url: window.location.href, buttons: document.querySelectorAll("button").length }' },
        { type: 'wait', timeout: 1000 }
      ]
    });

    // Debug app state
    this.sequences.set('debug_app', {
      name: 'debug_app', 
      description: 'Debug the current state of the app',
      actions: [
        { type: 'evaluate', script: 'return { readyState: document.readyState, elements: document.querySelectorAll("*").length }' },
        { type: 'screenshot' },
        { type: 'evaluate', script: 'return Array.from(document.querySelectorAll("button")).map(b => ({ text: b.textContent, id: b.id, class: b.className }))' }
      ]
    });
  }

  private async sendCDPCommand(method: string, params?: any): Promise<any> {
    try {
      const response = await fetch(`http://localhost:${this.debugPort}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: Date.now(),
          method,
          params,
          jsonrpc: '2.0'
        })
      });

      if (response.ok) {
        const result = await response.json();
        return {
          success: !(result as any).error,
          data: (result as any).result || (result as any).error
        };
      } else {
        return {
          success: false,
          error: `HTTP ${response.status}`
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default PlaywrightControlTool;