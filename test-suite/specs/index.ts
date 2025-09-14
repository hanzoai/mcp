/**
 * Unified tool test specifications for all MCP tools
 */

import { ToolTestSpec } from '../src/types.js';
import { coreToolSpecs } from './core-tools.js';
import { uiToolSpecs } from './ui-tools.js';
import { autoguiToolSpecs } from './autogui-tools.js';

export { coreToolSpecs } from './core-tools.js';
export { uiToolSpecs } from './ui-tools.js';
export { autoguiToolSpecs } from './autogui-tools.js';

/**
 * All tool specifications combined
 */
export const allToolSpecs: ToolTestSpec[] = [
  ...coreToolSpecs,
  ...uiToolSpecs,
  ...autoguiToolSpecs
];

/**
 * Get tool specifications by category
 */
export function getToolSpecsByCategory(category: string): ToolTestSpec[] {
  return allToolSpecs.filter(spec => spec.category === category);
}

/**
 * Get tool specification by name
 */
export function getToolSpec(name: string): ToolTestSpec | undefined {
  return allToolSpecs.find(spec => spec.name === name);
}

/**
 * Get all unique categories
 */
export function getCategories(): string[] {
  return [...new Set(allToolSpecs.map(spec => spec.category))];
}

/**
 * Get tool specifications by filter
 */
export function getToolSpecs(filter?: {
  categories?: string[];
  names?: string[];
  requiresSetup?: boolean;
}): ToolTestSpec[] {
  let filtered = allToolSpecs;

  if (filter?.categories) {
    filtered = filtered.filter(spec => 
      filter.categories!.includes(spec.category)
    );
  }

  if (filter?.names) {
    filtered = filtered.filter(spec => 
      filter.names!.includes(spec.name)
    );
  }

  if (filter?.requiresSetup !== undefined) {
    filtered = filtered.filter(spec => 
      Boolean(spec.requiresSetup) === filter.requiresSetup
    );
  }

  return filtered;
}

/**
 * Statistics about tool specifications
 */
export function getSpecStats() {
  const categories = getCategories();
  const totalSpecs = allToolSpecs.length;
  const totalTestCases = allToolSpecs.reduce(
    (sum, spec) => sum + spec.testCases.length, 
    0
  );
  
  const categoryStats = categories.map(category => ({
    category,
    specs: getToolSpecsByCategory(category).length,
    testCases: getToolSpecsByCategory(category).reduce(
      (sum, spec) => sum + spec.testCases.length,
      0
    )
  }));

  return {
    totalSpecs,
    totalTestCases,
    categories: categoryStats,
    toolsWithSetup: allToolSpecs.filter(s => s.requiresSetup).length
  };
}