/**
 * Registry types for Hanzo UI components
 * Based on the shadcn/ui registry format
 */

import { z } from "zod";

// Define the file schema to match shadcn/ui's format
export const fileSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  type: z.string(),
  target: z.string().optional(),
});

// Registry item schema aligned with shadcn/ui format
export const registryItemSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  devDependencies: z.array(z.string()).optional(),
  registryDependencies: z.array(z.string()).optional(),
  files: z.array(fileSchema).optional(),
  meta: z.record(z.any()).optional(),
  title: z.string().optional(),
  cssVars: z.record(z.any()).optional(),
  tailwind: z.record(z.any()).optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
});

// Registry schema aligned with shadcn/ui format
export const registrySchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  homepage: z.string().optional(),
  style: z.string().optional(),
  items: z.array(registryItemSchema),
});

// Schema for a registry with full content
export const registryWithContentSchema = registrySchema.extend({
  items: z.array(
    registryItemSchema.extend({
      files: z.array(
        fileSchema.extend({
          content: z.string(),
        })
      ),
    })
  ),
});

// Type definitions for easier use in TypeScript
export type RegistryItem = z.infer<typeof registryItemSchema>;
export type Registry = z.infer<typeof registrySchema>;
export type RegistryWithContent = z.infer<typeof registryWithContentSchema>;
export type RegistryFile = z.infer<typeof fileSchema>;