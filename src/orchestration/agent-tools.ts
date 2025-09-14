/**
 * Agent orchestration tools for MCP
 * Integrates with Hanzo Dev CLI and Python SDK
 */

import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// Agent status enum matching dev CLI
export enum AgentStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled'
}

// Agent configuration
export interface AgentConfig {
  id: string;
  model: string;
  prompt: string;
  context?: string;
  outputGoal?: string;
  files?: string[];
  readOnly?: boolean;
  status: AgentStatus;
  result?: string;
  error?: string;
  worktreePath?: string;
  branchName?: string;
}

// Active agents tracking
const activeAgents = new Map<string, AgentConfig>();

/**
 * Spawn a new agent for delegated tasks
 */
export const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description: 'Spawn a new AI agent to handle a specific task with optional model selection and constraints',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task prompt for the agent'
      },
      model: {
        type: 'string',
        description: 'Model to use (e.g., claude-3-opus, gpt-4, llama-3.2-3b)',
        default: 'claude-3-5-sonnet-20241022'
      },
      context: {
        type: 'string',
        description: 'Additional context for the agent'
      },
      outputGoal: {
        type: 'string',
        description: 'Expected output format or goal'
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files the agent should work with'
      },
      readOnly: {
        type: 'boolean',
        description: 'Whether agent has read-only access',
        default: false
      },
      useWorktree: {
        type: 'boolean',
        description: 'Create isolated Git worktree for agent',
        default: false
      }
    },
    required: ['prompt']
  }
};

/**
 * Orchestrate multiple agents in a swarm
 */
export const swarmOrchestrationTool: Tool = {
  name: 'swarm_orchestration',
  description: 'Orchestrate multiple agents working in parallel or sequence with coordination',
  inputSchema: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            prompt: { type: 'string' },
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Agent IDs this agent depends on'
            }
          },
          required: ['model', 'prompt']
        },
        description: 'Array of agent configurations'
      },
      orchestrationMode: {
        type: 'string',
        enum: ['parallel', 'sequential', 'hierarchical', 'consensus'],
        description: 'How agents should be coordinated',
        default: 'parallel'
      },
      consensusRounds: {
        type: 'number',
        description: 'Number of consensus rounds for consensus mode',
        default: 2
      }
    },
    required: ['agents']
  }
};

/**
 * Critic agent for code review and quality gates
 */
export const criticAgentTool: Tool = {
  name: 'critic_agent',
  description: 'Spawn a critic agent to review code, suggest improvements, and enforce quality standards',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Code to review'
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to review'
      },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Review criteria (e.g., security, performance, style)',
        default: ['security', 'performance', 'maintainability', 'testing']
      },
      severity: {
        type: 'string',
        enum: ['info', 'warning', 'error', 'critical'],
        description: 'Minimum severity to report',
        default: 'warning'
      }
    },
    required: []
  }
};

/**
 * Connect to Hanzo node for distributed processing
 */
export const hanzoNodeTool: Tool = {
  name: 'hanzo_node',
  description: 'Connect to or spawn a Hanzo compute node for distributed AI processing',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'connect'],
        description: 'Action to perform'
      },
      models: {
        type: 'array',
        items: { type: 'string' },
        description: 'Models to load on the node'
      },
      network: {
        type: 'boolean',
        description: 'Enable network discovery',
        default: false
      },
      blockchain: {
        type: 'boolean',
        description: 'Enable blockchain consensus',
        default: false
      }
    },
    required: ['action']
  }
};

/**
 * LLM routing and model selection
 */
export const llmRouterTool: Tool = {
  name: 'llm_router',
  description: 'Route requests to optimal LLM based on task requirements and cost optimization',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The prompt to route'
      },
      taskType: {
        type: 'string',
        enum: ['code_generation', 'analysis', 'refactoring', 'documentation', 'testing', 'simple'],
        description: 'Type of task'
      },
      requirements: {
        type: 'object',
        properties: {
          quality: {
            type: 'string',
            enum: ['maximum', 'balanced', 'fast'],
            default: 'balanced'
          },
          maxCost: {
            type: 'number',
            description: 'Maximum cost in USD'
          },
          maxLatency: {
            type: 'number',
            description: 'Maximum latency in seconds'
          }
        }
      },
      fallbackChain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fallback model chain',
        default: ['claude-3-5-sonnet', 'gpt-4', 'gemini-pro', 'llama-3.2']
      }
    },
    required: ['prompt']
  }
};

/**
 * Consensus mechanism for multi-agent decisions
 */
export const consensusTool: Tool = {
  name: 'consensus',
  description: 'Achieve consensus among multiple agents using various voting mechanisms',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Question or decision to reach consensus on'
      },
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to participate'
      },
      mechanism: {
        type: 'string',
        enum: ['majority', 'unanimous', 'weighted', 'ranked'],
        description: 'Consensus mechanism',
        default: 'majority'
      },
      rounds: {
        type: 'number',
        description: 'Number of voting rounds',
        default: 1
      }
    },
    required: ['question', 'agents']
  }
};

/**
 * Execute agent tool handlers
 */
export async function executeAgentTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'spawn_agent':
      return spawnAgent(args);
    
    case 'swarm_orchestration':
      return orchestrateSwarm(args);
    
    case 'critic_agent':
      return runCriticAgent(args);
    
    case 'hanzo_node':
      return manageHanzoNode(args);
    
    case 'llm_router':
      return routeLLMRequest(args);
    
    case 'consensus':
      return achieveConsensus(args);
    
    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}

/**
 * Spawn a single agent
 */
async function spawnAgent(args: z.infer<typeof spawnAgentSchema>) {
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  const config: AgentConfig = {
    id: agentId,
    model: args.model || 'claude-3-5-sonnet-20241022',
    prompt: args.prompt,
    context: args.context,
    outputGoal: args.outputGoal,
    files: args.files,
    readOnly: args.readOnly || false,
    status: AgentStatus.Pending
  };
  
  // Create worktree if requested
  if (args.useWorktree) {
    const branchName = `agent-${agentId}`;
    const worktreePath = path.join(process.cwd(), '.worktrees', branchName);
    
    await executeCommand(`git worktree add -b ${branchName} ${worktreePath}`);
    config.worktreePath = worktreePath;
    config.branchName = branchName;
  }
  
  activeAgents.set(agentId, config);
  
  // Spawn agent process using Hanzo CLI
  const hanzoCmd = await findHanzoCommand();
  const agentArgs = [
    'agent',
    'spawn',
    '--model', config.model,
    '--prompt', config.prompt
  ];
  
  if (config.context) agentArgs.push('--context', config.context);
  if (config.outputGoal) agentArgs.push('--output-goal', config.outputGoal);
  if (config.files) agentArgs.push('--files', config.files.join(','));
  if (config.readOnly) agentArgs.push('--read-only');
  
  const agentProcess = spawn(hanzoCmd, agentArgs, {
    cwd: config.worktreePath || process.cwd(),
    stdio: 'pipe'
  });
  
  // Handle agent output
  let output = '';
  agentProcess.stdout?.on('data', (data) => {
    output += data.toString();
  });
  
  agentProcess.stderr?.on('data', (data) => {
    console.error(`Agent ${agentId} error:`, data.toString());
  });
  
  return new Promise((resolve, reject) => {
    agentProcess.on('close', (code) => {
      const agent = activeAgents.get(agentId);
      if (agent) {
        if (code === 0) {
          agent.status = AgentStatus.Completed;
          agent.result = output;
        } else {
          agent.status = AgentStatus.Failed;
          agent.error = `Process exited with code ${code}`;
        }
        activeAgents.set(agentId, agent);
      }
      
      if (code === 0) {
        resolve({
          agentId,
          status: 'completed',
          result: output
        });
      } else {
        reject(new Error(`Agent failed with code ${code}`));
      }
    });
  });
}

/**
 * Orchestrate agent swarm
 */
async function orchestrateSwarm(args: z.infer<typeof swarmOrchestrationSchema>) {
  const { agents, orchestrationMode, consensusRounds } = args;
  
  switch (orchestrationMode) {
    case 'parallel':
      // Spawn all agents in parallel
      const parallelResults = await Promise.all(
        agents.map(agent => spawnAgent({
          prompt: agent.prompt,
          model: agent.model
        }))
      );
      return { mode: 'parallel', results: parallelResults };
    
    case 'sequential':
      // Spawn agents one by one
      const sequentialResults = [];
      for (const agent of agents) {
        const result = await spawnAgent({
          prompt: agent.prompt,
          model: agent.model
        });
        sequentialResults.push(result);
      }
      return { mode: 'sequential', results: sequentialResults };
    
    case 'hierarchical':
      // Implement dependency-based execution
      return { mode: 'hierarchical', message: 'Hierarchical orchestration initiated' };
    
    case 'consensus':
      // Implement consensus mechanism
      return { 
        mode: 'consensus', 
        rounds: consensusRounds,
        message: 'Consensus orchestration initiated' 
      };
    
    default:
      throw new Error(`Unknown orchestration mode: ${orchestrationMode}`);
  }
}

/**
 * Run critic agent for code review
 */
async function runCriticAgent(args: any) {
  const hanzoCmd = await findHanzoCommand();
  
  const criticArgs = [
    'agent',
    'critic',
    '--criteria', args.criteria?.join(',') || 'all',
    '--severity', args.severity || 'warning'
  ];
  
  if (args.code) {
    // Write code to temp file for review
    const tempFile = path.join('/tmp', `critic-${Date.now()}.code`);
    await fs.writeFile(tempFile, args.code);
    criticArgs.push('--file', tempFile);
  } else if (args.files) {
    criticArgs.push('--files', args.files.join(','));
  }
  
  return executeCommand(`${hanzoCmd} ${criticArgs.join(' ')}`);
}

/**
 * Manage Hanzo compute node
 */
async function manageHanzoNode(args: any) {
  const hanzoCmd = await findHanzoCommand();
  
  switch (args.action) {
    case 'start':
      const startArgs = ['node', 'start'];
      if (args.models) startArgs.push('--models', args.models.join(','));
      if (args.network) startArgs.push('--network');
      if (args.blockchain) startArgs.push('--blockchain');
      
      return executeCommand(`${hanzoCmd} ${startArgs.join(' ')}`);
    
    case 'stop':
      return executeCommand(`${hanzoCmd} node stop`);
    
    case 'status':
      return executeCommand(`${hanzoCmd} node status`);
    
    case 'connect':
      return executeCommand(`${hanzoCmd} node connect`);
    
    default:
      throw new Error(`Unknown node action: ${args.action}`);
  }
}

/**
 * Route LLM request to optimal model
 */
async function routeLLMRequest(args: any) {
  const hanzoCmd = await findHanzoCommand();
  
  const routerArgs = [
    'router',
    'route',
    '--prompt', args.prompt
  ];
  
  if (args.taskType) routerArgs.push('--task-type', args.taskType);
  if (args.requirements?.quality) routerArgs.push('--quality', args.requirements.quality);
  if (args.requirements?.maxCost) routerArgs.push('--max-cost', args.requirements.maxCost.toString());
  if (args.requirements?.maxLatency) routerArgs.push('--max-latency', args.requirements.maxLatency.toString());
  if (args.fallbackChain) routerArgs.push('--fallback', args.fallbackChain.join(','));
  
  return executeCommand(`${hanzoCmd} ${routerArgs.join(' ')}`);
}

/**
 * Achieve consensus among agents
 */
async function achieveConsensus(args: any) {
  const { question, agents, mechanism, rounds } = args;
  
  // Collect votes from each agent
  const votes = [];
  for (let round = 1; round <= rounds; round++) {
    const roundVotes = await Promise.all(
      agents.map(async (agentId: string) => {
        const agent = activeAgents.get(agentId);
        if (!agent) throw new Error(`Agent ${agentId} not found`);
        
        // Get agent's vote
        const voteResult = await spawnAgent({
          model: agent.model,
          prompt: `${question}\n\nProvide your answer/vote.`,
          context: round > 1 ? `Previous round votes: ${JSON.stringify(votes[round-2])}` : undefined
        });
        
        return {
          agentId,
          vote: voteResult.result,
          round
        };
      })
    );
    votes.push(roundVotes);
  }
  
  // Apply consensus mechanism
  const finalVotes = votes[rounds - 1];
  let consensus;
  
  switch (mechanism) {
    case 'majority':
      // Simple majority voting
      const voteCounts = new Map<string, number>();
      finalVotes.forEach(v => {
        const count = voteCounts.get(v.vote) || 0;
        voteCounts.set(v.vote, count + 1);
      });
      consensus = Array.from(voteCounts.entries())
        .sort((a, b) => b[1] - a[1])[0][0];
      break;
    
    case 'unanimous':
      // All must agree
      const firstVote = finalVotes[0].vote;
      consensus = finalVotes.every(v => v.vote === firstVote) ? firstVote : null;
      break;
    
    default:
      consensus = null;
  }
  
  return {
    question,
    mechanism,
    rounds,
    votes,
    consensus,
    achieved: consensus !== null
  };
}

/**
 * Helper to find Hanzo command
 */
async function findHanzoCommand(): Promise<string> {
  // Try different Hanzo command locations
  const commands = [
    'hanzo',
    path.join(process.env.HOME || '', '.local', 'bin', 'hanzo'),
    path.join(process.env.HOME || '', 'work', 'hanzo', 'python-sdk', 'hanzo'),
    'python -m hanzo.cli'
  ];
  
  for (const cmd of commands) {
    try {
      await executeCommand(`which ${cmd.split(' ')[0]}`);
      return cmd;
    } catch {
      continue;
    }
  }
  
  throw new Error('Hanzo CLI not found. Install with: pip install hanzo');
}

/**
 * Execute shell command
 */
function executeCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      stdio: 'pipe'
    });
    
    let output = '';
    let error = '';
    
    child.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      error += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(error || `Command failed with code ${code}`));
      }
    });
  });
}

// Schema definitions for validation
const spawnAgentSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  context: z.string().optional(),
  outputGoal: z.string().optional(),
  files: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
  useWorktree: z.boolean().optional()
});

const swarmOrchestrationSchema = z.object({
  agents: z.array(z.object({
    model: z.string(),
    prompt: z.string(),
    dependencies: z.array(z.string()).optional()
  })),
  orchestrationMode: z.enum(['parallel', 'sequential', 'hierarchical', 'consensus']).optional(),
  consensusRounds: z.number().optional()
});

// Export all orchestration tools
export const orchestrationTools: Tool[] = [
  spawnAgentTool,
  swarmOrchestrationTool,
  criticAgentTool,
  hanzoNodeTool,
  llmRouterTool,
  consensusTool
];