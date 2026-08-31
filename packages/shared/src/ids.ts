import { z } from 'zod';

export const IdSchema = z.string().min(1).max(160);
export const IdempotencyKeySchema = z.string().min(8).max(200);
export const IsoDateSchema = z.iso.datetime({ offset: true });
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:[\\/]/u.test(value) && !value.split(/[\\/]/u).includes('..') && !value.includes('\0'), {
    message: 'Expected a normalized relative path without traversal',
  });

export type Id = z.infer<typeof IdSchema>;
