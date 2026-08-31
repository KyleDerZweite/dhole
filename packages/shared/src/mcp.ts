import { z } from 'zod';
import { IdSchema } from './ids.js';

export const McpProtocolVersion = '2026-07-28' as const;

export const McpScopeSchema = z.object({
  projectId: IdSchema,
  runId: IdSchema.optional(),
  permissions: z.array(z.enum([
    'project:read',
    'coordination:write',
    'children:write',
    'memory:read',
    'memory:propose',
    'skills:read',
    'skills:propose',
    'benchmarks:run',
  ])).min(1),
});

export const McpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
  _meta: z.object({ protocolVersion: z.string() }).passthrough().optional(),
});

export type McpScope = z.infer<typeof McpScopeSchema>;
