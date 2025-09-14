/**
 * Registry API utilities for fetching and managing Hanzo UI components
 */

import { registryItemSchema, RegistryItem, Registry } from "./registry-types.js";

const registryCache = new Map<string, Promise<any>>();

/**
 * Gets the full registry URL based on the registry name or URL provided
 * @param registry - Registry name, URL, or file path
 * @returns The complete registry URL
 */
export function getRegistryUrl(registry: string): string {
  // Check if registry is a full URL
  if (registry.startsWith("http")) {
    return registry;
  }

  // Default to Hanzo registry if REGISTRY_BASE_URL is defined, otherwise use shadcn
  const baseUrl = process.env.REGISTRY_BASE_URL || "https://ui.hanzo.ai/registry";
  
  // Check if registry is a path to a JSON file
  if (registry.endsWith(".json")) {
    return `${baseUrl}/${registry}`;
  }

  // Assume registry is a registry style
  return `${baseUrl}/${registry}/registry.json`;
}

/**
 * Fetches a specific registry item by URL
 * @param itemUrl - The URL of the item to fetch
 * @param basePath - Base path for resolving imports
 * @returns The registry item or null if not found
 */
export async function getRegistryItem(
  itemUrl: string,
  basePath: string
): Promise<RegistryItem | null> {
  try {
    const response = await fetch(itemUrl);

    if (!response.ok) {
      console.error(`Failed to fetch registry item from ${itemUrl}: ${response.status} ${response.statusText}`);
      return null;
    }

    const item = await response.json();
    const validatedItem = registryItemSchema.safeParse(item);
    
    if (!validatedItem.success) {
      console.error(`Invalid registry item format: ${JSON.stringify(validatedItem.error)}`);
      return null;
    }

    // Process and resolve file paths
    if (validatedItem.data.files) {
      for (const file of validatedItem.data.files) {
        if (!file.content) {
          continue;
        }

        // If the file has a target, we resolve it from the target
        if (file.target) {
          file.target = resolveImport(file.target, basePath);
        }
      }
    }

    return validatedItem.data;
  } catch (error) {
    console.error(`Error fetching registry item: ${error}`);
    return null;
  }
}

/**
 * Resolves an import path relative to a base path
 * @param importPath - The import path to resolve
 * @param basePath - The base path to resolve against
 * @returns The resolved import path
 */
export function resolveImport(importPath: string, basePath: string): string {
  const importParts = importPath?.split("/");

  // Check if it's a relative import
  if (importPath.startsWith(".")) {
    return [basePath.replace(/^@/, ""), ...importParts].filter(Boolean).join("/");
  }

  // Check if it's a scope package
  if (importParts?.[0]?.startsWith("@")) {
    return importPath;
  }

  return importPath;
}

/**
 * Fetches registry data from one or more paths
 * @param paths - Array of registry paths to fetch
 * @param options - Options for fetching the registry
 * @returns Array of registry data
 */
export async function fetchRegistry(
  paths: string[],
  options: { useCache?: boolean } = {}
): Promise<Registry[]> {
  options = {
    useCache: true,
    ...options,
  };

  try {
    const results = await Promise.all(
      paths.map(async (path) => {
        const url = getRegistryUrl(path);

        // Check cache first if caching is enabled
        if (options.useCache && registryCache.has(url)) {
          return registryCache.get(url);
        }

        // Store the promise in the cache before awaiting if caching is enabled
        const fetchPromise = (async () => {
          const response = await fetch(url);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch registry from ${url}. ${response.status} ${response.statusText}`
            );
          }

          return response.json();
        })();

        if (options.useCache) {
          registryCache.set(url, fetchPromise);
        }
        return fetchPromise;
      })
    );

    return results;
  } catch (error) {
    console.error(`Error fetching registry: ${error}`);
    throw error;
  }
}

/**
 * Gets the URL for a specific registry item
 * @param itemName - The name of the registry item
 * @param registryUrl - The base registry URL
 * @returns The URL for the specific registry item
 */
export function getRegistryItemUrl(itemName: string, registryUrl: string): string {
  const registryBaseUrl = registryUrl.replace(/\/registry\.json$/, "");
  return `${registryBaseUrl}/r/${itemName}.json`;
}