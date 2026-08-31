import { randomBytes, randomUUID } from 'node:crypto';

export interface Clock {
  now(): Date;
}

export interface IdSource {
  id(): string;
  token(bytes?: number): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const secureIds: IdSource = {
  id: () => randomUUID(),
  token: (bytes = 32) => randomBytes(bytes).toString('base64url'),
};
