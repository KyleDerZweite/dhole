import { z } from 'zod';
import { IdSchema } from './ids.js';

export const McpProtocolVersion = '2026-07-28' as const;

export const TokenPermissionSchema = z.enum([
  'projects:create',
  'project:read',
  'coordination:write',
  'fleet:admin',
  'children:write',
  'memory:read',
  'memory:propose',
  'skills:read',
  'skills:propose',
  'benchmarks:run',
  'gateway:read',
  'gateway:ingest',
  'gateway:manage',
]);

export type TokenPermission = z.infer<typeof TokenPermissionSchema>;
export const ProjectTokenPermissionSchema = TokenPermissionSchema.exclude(['projects:create']);

export const McpScopeSchema = z.object({
  projectId: IdSchema,
  runId: IdSchema.optional(),
  permissions: z.array(ProjectTokenPermissionSchema).min(1),
});

export const McpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
  _meta: z.object({ protocolVersion: z.string() }).passthrough().optional(),
});

export type McpScope = z.infer<typeof McpScopeSchema>;
