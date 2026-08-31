import { z } from 'zod';
import { EventEnvelopeSchema } from './events.js';
import { IdSchema, IdempotencyKeySchema } from './ids.js';

export const RuntimeKindSchema = z.enum(['fake', 'codex', 'claude-code', 'kimi-code', 'openai-compatible']);

export const RuntimeCapabilitiesSchema = z.object({
  sessionCreation: z.boolean(),
  sessionResume: z.boolean(),
  nextTurnMessage: z.boolean(),
  activeTurnSteering: z.boolean(),
  cancellation: z.boolean(),
  approvalResponses: z.boolean(),
  historyReplay: z.boolean(),
  structuredToolEvents: z.boolean(),
  nativeSubagentObservation: z.boolean(),
  imageInput: z.boolean(),
  structuredOutput: z.boolean(),
  repositoryEditing: z.boolean(),
  terminalTools: z.boolean(),
});

export const RuntimeAvailabilitySchema = z.object({
  available: z.boolean(),
  executable: z.string().max(240).optional(),
  version: z.string().max(120).optional(),
  reason: z.string().max(500).optional(),
});

export const RuntimeDescriptorSchema = z.object({
  id: IdSchema,
  kind: RuntimeKindSchema,
  label: z.string().min(1).max(120),
  protocolVersion: z.string().min(1).max(80),
  capabilities: RuntimeCapabilitiesSchema,
  availability: RuntimeAvailabilitySchema,
});

export const RuntimeTurnInputSchema = z.object({
  operationId: IdempotencyKeySchema,
  sessionId: IdSchema,
  activationId: IdSchema,
  message: z.string().min(1).max(200_000),
  attachments: z
    .array(z.object({ mediaType: z.string().max(100), reference: z.string().max(500) }))
    .max(16)
    .default([]),
});

export const RuntimeEventSchema = z.object({
  operationId: IdempotencyKeySchema,
  event: EventEnvelopeSchema,
  transient: z.boolean().default(false),
});

export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;
export type RuntimeTurnInput = z.infer<typeof RuntimeTurnInputSchema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
