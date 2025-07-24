/**
 * System prompt for Hanzo MCP
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

export async function getSystemPrompt(projectPath: string = process.cwd()): Promise<string> {
  const parts: string[] = [];
  
  // Header
  parts.push('# Hanzo MCP System Context\n');
  parts.push(`Generated at: ${new Date().toISOString()}\n`);
  
  // Environment
  parts.push('## Environment');
  parts.push(`- OS: ${os.platform()} ${os.release()}`);
  parts.push(`- Node: ${process.version}`);
  parts.push(`- Working Directory: ${projectPath}`);
  parts.push(`- User: ${os.userInfo().username}`);
  parts.push(`- Home: ${os.homedir()}\n`);
  
  // Git Status
  try {
    const { stdout: gitStatus } = await execAsync('git status --porcelain', { cwd: projectPath });
    const { stdout: gitBranch } = await execAsync('git branch --show-current', { cwd: projectPath });
    const { stdout: gitRemote } = await execAsync('git remote -v', { cwd: projectPath });
    
    parts.push('## Git Repository');
    parts.push(`- Branch: ${gitBranch.trim()}`);
    parts.push(`- Status: ${gitStatus ? 'Modified files present' : 'Clean'}`);
    if (gitRemote) {
      const remoteUrl = gitRemote.split('\n')[0]?.split('\t')[1]?.split(' ')[0];
      if (remoteUrl) {
        parts.push(`- Remote: ${remoteUrl}`);
      }
    }
    
    if (gitStatus) {
      parts.push('\n### Modified Files:');
      parts.push('```');
      parts.push(gitStatus.trim());
      parts.push('```');
    }
    parts.push('');
  } catch {
    parts.push('## Git Repository');
    parts.push('- Not a git repository\n');
  }
  
  // Project Structure
  parts.push('## Project Structure');
  try {
    // Check for common project files
    const projectFiles = [
      'package.json',
      'tsconfig.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'Gemfile',
      'pom.xml',
      'build.gradle',
      'Makefile',
      'README.md',
      '.env.example'
    ];
    
    const foundFiles: string[] = [];
    for (const file of projectFiles) {
      try {
        await fs.access(path.join(projectPath, file));
        foundFiles.push(file);
      } catch {
        // File doesn't exist
      }
    }
    
    if (foundFiles.length > 0) {
      parts.push('- Project files found: ' + foundFiles.join(', '));
    }
    
    // Detect project type
    if (foundFiles.includes('package.json')) {
      try {
        const packageJson = JSON.parse(
          await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8')
        );
        parts.push(`- Node.js project: ${packageJson.name || 'unnamed'}`);
        if (packageJson.dependencies?.react) parts.push('- Framework: React');
        if (packageJson.dependencies?.vue) parts.push('- Framework: Vue');
        if (packageJson.dependencies?.angular) parts.push('- Framework: Angular');
        if (packageJson.dependencies?.express) parts.push('- Framework: Express');
        if (packageJson.dependencies?.next) parts.push('- Framework: Next.js');
      } catch {
        // Ignore errors
      }
    }
    
    if (foundFiles.includes('pyproject.toml')) {
      parts.push('- Python project (Poetry/Modern)');
    }
    
    if (foundFiles.includes('Cargo.toml')) {
      parts.push('- Rust project');
    }
    
    if (foundFiles.includes('go.mod')) {
      parts.push('- Go project');
    }
  } catch {
    // Ignore errors
  }
  parts.push('');
  
  // Available Tools
  parts.push('## Available MCP Tools');
  parts.push(`Total tools: ${(await import('../tools/index.js')).allTools.length}\n`);
  
  parts.push('### File Operations');
  parts.push('- `read_file`: Read file contents');
  parts.push('- `write_file`: Write content to a file');
  parts.push('- `edit_file`: Replace text in a file');
  parts.push('- `multi_edit`: Make multiple edits to a file');
  parts.push('- `create_file`: Create a new file');
  parts.push('- `delete_file`: Delete a file or directory');
  parts.push('- `move_file`: Move or rename files');
  parts.push('- `list_files`: List files in a directory');
  parts.push('- `directory_tree`: Display directory structure');
  parts.push('- `get_file_info`: Get file metadata\n');
  
  parts.push('### Search Tools');
  parts.push('- `search`: Unified search (filenames + content)');
  parts.push('- `grep`: Search using grep/ripgrep');
  parts.push('- `find_files`: Find files by name pattern\n');
  
  parts.push('### Shell Tools');
  parts.push('- `bash`: Execute bash commands');
  parts.push('- `run_command`: Execute shell commands');
  parts.push('- `run_background`: Run commands in background');
  parts.push('- `list_processes`: List background processes');
  parts.push('- `get_process_output`: Get process output');
  parts.push('- `kill_process`: Kill a background process\n');
  
  // Guidelines
  parts.push('## Guidelines');
  parts.push('- Use absolute paths when possible');
  parts.push('- Check file existence before editing');
  parts.push('- Use `multi_edit` for multiple changes to the same file');
  parts.push('- Prefer `search` for comprehensive searches');
  parts.push('- Use `directory_tree` to understand project structure');
  parts.push('- Background processes are useful for long-running tasks\n');
  
  // Code Reference Format
  parts.push('## Code Reference Format');
  parts.push('When referencing code, use: `filename:line_number`');
  parts.push('Example: `src/index.ts:42`\n');
  
  return parts.join('\n');
}