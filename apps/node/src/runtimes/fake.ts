import type { NodeCommand, RuntimeCapabilities } from '@dhole-control/shared';
import { descriptorFor, eventEmitter, type RuntimeAdapter, type RuntimeAdapterEvent, type RuntimeAdapterOptions, type RuntimeExecutionContext, type RuntimeExecutionResult } from './types.js';

const capabilities: RuntimeCapabilities = {
  sessionCreation: true,
  sessionResume: true,
  nextTurnMessage: true,
  activeTurnSteering: true,
  cancellation: true,
  approvalResponses: true,
  historyReplay: true,
  structuredToolEvents: true,
  nativeSubagentObservation: true,
  imageInput: true,
  structuredOutput: true,
  repositoryEditing: true,
  terminalTools: true,
};

/** Deterministic local adapter used by tests and demo mode; it never contacts a provider. */
export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'fake' as const;
  readonly label = 'Deterministic Fake Runtime';
  readonly protocolVersion = 'fixture.v1';
  readonly capabilities = capabilities;
  readonly availability = { available: true, executable: 'fixture', version: 'fake-1' };
  private readonly sessions = new Map<string, string[]>();

  constructor(_options: RuntimeAdapterOptions = {}) {}

  descriptor(id = 'runtime-fake'): ReturnType<typeof descriptorFor> {
    return descriptorFor(this, id);
  }

  async execute(command: NodeCommand, context: RuntimeExecutionContext = {}): Promise<RuntimeExecutionResult> {
    const events: RuntimeAdapterEvent[] = [];
    const emit = eventEmitter(context, events);
    switch (command.kind) {
      case 'create_runtime_session': {
        const sessionId = `fake-${command.runtimeSessionKey}`;
        this.sessions.set(sessionId, []);
        emit({ type: 'session.created', runtimeSessionId: sessionId });
        return { runtimeSessionId: sessionId, events };
      }
      case 'resume_runtime_session': {
        if (!this.sessions.has(command.runtimeSessionId)) this.sessions.set(command.runtimeSessionId, []);
        emit({ type: 'session.resumed', runtimeSessionId: command.runtimeSessionId });
        return { runtimeSessionId: command.runtimeSessionId, events };
      }
      case 'send_message': {
        const messages = this.sessions.get(command.runtimeSessionId) ?? [];
        messages.push(command.message);
        this.sessions.set(command.runtimeSessionId, messages);
        const turnId = `turn-${command.operationKey}`;
        const text = `Fake response: ${command.message}`;
        emit({ type: 'turn.started', runtimeSessionId: command.runtimeSessionId, turnId });
        emit({ type: 'message.delta', runtimeSessionId: command.runtimeSessionId, turnId, delta: text });
        emit({ type: 'message.completed', runtimeSessionId: command.runtimeSessionId, turnId, text });
        return { runtimeSessionId: command.runtimeSessionId, turnId, text, events };
      }
      case 'steer':
        emit({ type: 'turn.steered', runtimeSessionId: command.runtimeSessionId, turnId: command.turnId, message: command.message });
        return { runtimeSessionId: command.runtimeSessionId, turnId: command.turnId, events };
      case 'cancel':
        emit({ type: 'turn.cancelled', runtimeSessionId: command.runtimeSessionId, ...(command.turnId ? { turnId: command.turnId } : {}) });
        return { runtimeSessionId: command.runtimeSessionId, ...(command.turnId ? { turnId: command.turnId } : {}), events };
      case 'answer_approval':
        emit({ type: 'approval.answered', runtimeSessionId: command.runtimeSessionId, approvalId: command.approvalId, decision: command.decision });
        return { runtimeSessionId: command.runtimeSessionId, events };
      default:
        return { events };
    }
  }
}
