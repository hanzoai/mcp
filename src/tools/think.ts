/**
 * AI tool — single tool, action-routed intelligence
 * think, critic, consensus, agent, summarize, classify, embed, explain, translate, compare, chain
 */

import { Tool } from '../types/index.js';

export const thinkTool: Tool = {
  name: 'think',
  description: 'LLM reasoning & intelligence: think (structured reasoning), critic (code review), consensus (multi-model), agent (delegate), summarize, classify, embed, explain, translate, compare, chain (multi-step)',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'think', 'critic', 'consensus', 'agent',
        'summarize', 'classify', 'embed', 'explain',
        'translate', 'compare', 'chain'
      ], description: 'AI action' },
      // think/critic
      thought: { type: 'string', description: 'What to think about / critique' },
      context: { type: 'string', description: 'Additional context' },
      code: { type: 'string', description: 'Code to analyze (critic)' },
      language: { type: 'string', description: 'Programming or natural language' },
      // consensus
      question: { type: 'string', description: 'Question for reasoning / consensus' },
      models: { type: 'array', items: { type: 'string' }, description: 'Model IDs for consensus', default: ['claude-sonnet-4-20250514', 'gpt-4o'] },
      // agent
      task: { type: 'string', description: 'Task for agent delegation' },
      model: { type: 'string', default: 'claude-sonnet-4-20250514' },
      system: { type: 'string', description: 'System prompt' },
      maxTokens: { type: 'number', default: 1000 },
      temperature: { type: 'number' },
      // summarize
      text: { type: 'string', description: 'Text to summarize/classify/translate/explain' },
      maxLength: { type: 'number', description: 'Max summary length in words', default: 100 },
      format: { type: 'string', description: 'Output format: bullets, paragraph, json', default: 'bullets' },
      // classify
      categories: { type: 'array', items: { type: 'string' }, description: 'Classification categories' },
      // translate
      targetLanguage: { type: 'string', description: 'Target language for translation' },
      // compare
      texts: { type: 'array', items: { type: 'string' }, description: 'Texts to compare' },
      // chain
      steps: { type: 'array', items: { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' } } }, description: 'Chain steps' }
    },
    required: ['action']
  },
  handler: async (args) => {
    const apiKey = process.env.HANZO_API_KEY || process.env.API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl = (process.env.API_URL || 'https://api.hanzo.ai') + '/v1';

    async function llm(prompt: string, opts: { model?: string; system?: string; maxTokens?: number; temperature?: number } = {}): Promise<string> {
      if (!apiKey) throw new Error('HANZO_API_KEY required');
      const msgs: any[] = [];
      if (opts.system) msgs.push({ role: 'system', content: opts.system });
      msgs.push({ role: 'user', content: prompt });
      const body: any = { model: opts.model || args.model || 'auto', messages: msgs, max_tokens: opts.maxTokens || args.maxTokens || 1000 };
      if (opts.temperature !== undefined || args.temperature !== undefined) body.temperature = opts.temperature ?? args.temperature;
      const r = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as any;
      return d.choices?.[0]?.message?.content || '(empty)';
    }

    try {
      switch (args.action) {
        case 'think':
          return { content: [{ type: 'text', text: `Thinking: ${args.thought || args.question || ''}\n${args.context ? `Context: ${args.context}` : ''}\n\nUse this tool to structure reasoning, break down problems, evaluate tradeoffs, and plan before acting. Not an LLM call — a scratchpad for the agent's own reasoning.` }] };

        case 'critic':
          return { content: [{ type: 'text', text: `Critical Analysis: ${args.thought || ''}\n${args.code ? `\nCode:\n\`\`\`${args.language || ''}\n${args.code}\n\`\`\`\n` : ''}\nConsider: edge cases, security, error handling, performance, readability, patterns, tests, simplicity, OWASP, race conditions, resource leaks.` }] };

        case 'consensus': {
          if (!args.question) return { content: [{ type: 'text', text: 'question required' }], isError: true };
          if (!apiKey) return { content: [{ type: 'text', text: 'HANZO_API_KEY required' }], isError: true };
          const models = args.models || ['claude-sonnet-4-20250514', 'gpt-4o'];
          const responses: Record<string, string> = {};
          const errors: Record<string, string> = {};
          await Promise.allSettled(models.map(async (m: string) => {
            try { responses[m] = await llm(args.question, { model: m }); }
            catch (e: any) { errors[m] = e.message; }
          }));
          const out = [`Consensus: "${args.question}"\n`];
          for (const [m, r] of Object.entries(responses)) out.push(`**${m}:**\n${r}\n`);
          for (const [m, e] of Object.entries(errors)) out.push(`${m}: ${e}`);
          if (Object.keys(responses).length > 1) {
            out.push('\n---\nAgreement points and divergences are highlighted above. Cross-reference for confidence.');
          }
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'agent': {
          if (!args.task) return { content: [{ type: 'text', text: 'task required' }], isError: true };
          if (!apiKey) return { content: [{ type: 'text', text: 'HANZO_API_KEY required' }], isError: true };
          const result = await llm(args.task, { system: args.system || `You are a specialized agent. Complete the following task thoroughly and return the result.`, model: args.model, maxTokens: args.maxTokens });
          return { content: [{ type: 'text', text: `Agent (${args.model || 'auto'}):\n\n${result}` }] };
        }

        case 'summarize': {
          if (!args.text) return { content: [{ type: 'text', text: 'text required' }], isError: true };
          const result = await llm(args.text, { system: `Summarize the following in ${args.maxLength || 100} words or fewer. Format: ${args.format || 'bullets'}. Be concise and capture key points.` });
          return { content: [{ type: 'text', text: result }] };
        }

        case 'classify': {
          if (!args.text) return { content: [{ type: 'text', text: 'text required' }], isError: true };
          const cats = args.categories?.length ? `Categories: ${args.categories.join(', ')}` : 'Determine the most appropriate categories.';
          const result = await llm(args.text, { system: `Classify the following text. ${cats}\nReturn: category, confidence (0-1), reasoning.` });
          return { content: [{ type: 'text', text: result }] };
        }

        case 'embed': {
          if (!args.text) return { content: [{ type: 'text', text: 'text required' }], isError: true };
          if (!apiKey) return { content: [{ type: 'text', text: 'HANZO_API_KEY required' }], isError: true };
          const r = await fetch(`${baseUrl}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model: args.model || 'text-embedding-3-small', input: args.text }) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json() as any;
          const emb = d.data?.[0]?.embedding || [];
          return { content: [{ type: 'text', text: `Embedding (${emb.length} dims): [${emb.slice(0, 8).map((x: number) => x.toFixed(4)).join(', ')}...]` }] };
        }

        case 'explain': {
          const input = args.text || args.code || args.thought;
          if (!input) return { content: [{ type: 'text', text: 'text, code, or thought required' }], isError: true };
          const lang = args.language ? ` (${args.language})` : '';
          const result = await llm(input, { system: `Explain the following${lang} clearly and concisely. Target audience: experienced developer. Cover what it does, how it works, and why.` });
          return { content: [{ type: 'text', text: result }] };
        }

        case 'translate': {
          if (!args.text) return { content: [{ type: 'text', text: 'text required' }], isError: true };
          if (!args.targetLanguage) return { content: [{ type: 'text', text: 'targetLanguage required' }], isError: true };
          const result = await llm(args.text, { system: `Translate to ${args.targetLanguage}. Preserve tone, technical terms, and formatting.` });
          return { content: [{ type: 'text', text: result }] };
        }

        case 'compare': {
          const items = args.texts || [];
          if (items.length < 2) return { content: [{ type: 'text', text: 'texts array with 2+ items required' }], isError: true };
          const prompt = items.map((t: string, i: number) => `--- Item ${i + 1} ---\n${t}`).join('\n\n');
          const result = await llm(prompt, { system: 'Compare the following items. Identify: similarities, differences, strengths, weaknesses, and recommendation.' });
          return { content: [{ type: 'text', text: result }] };
        }

        case 'chain': {
          if (!args.steps?.length) return { content: [{ type: 'text', text: 'steps array required' }], isError: true };
          if (!apiKey) return { content: [{ type: 'text', text: 'HANZO_API_KEY required' }], isError: true };
          const results: string[] = [];
          let context = '';
          for (const [i, step] of args.steps.entries()) {
            const prompt = context ? `Previous context:\n${context}\n\n---\n\n${step.prompt}` : step.prompt;
            const result = await llm(prompt, { model: step.model, system: args.system });
            results.push(`Step ${i + 1}: ${result}`);
            context = result;
          }
          return { content: [{ type: 'text', text: results.join('\n\n---\n\n') }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
};

export const thinkTools = [thinkTool];
