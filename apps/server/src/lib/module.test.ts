import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerModules, selectModules, type DholeApp, type DholeModule, type ServerContext } from './module.js';

const module = (id: string, dependencies: readonly string[] = []): DholeModule => ({ id, dependencies, register: vi.fn() });

describe('static module selection', () => {
  it('orders explicit dependencies and leaves unselected modules out', () => {
    const modules = [module('dependent', ['base']), module('unused'), module('base')];
    expect(selectModules(modules, ['dependent', 'base']).map((item) => item.id)).toEqual(['base', 'dependent']);
  });

  it('rejects unknown, disabled, duplicate and circular dependencies before registering anything', () => {
    const base = module('base');
    const dependent = module('dependent', ['base']);
    expect(() => selectModules([base], ['missing'])).toThrow('Unknown module id missing');
    expect(() => selectModules([base, dependent], ['dependent'])).toThrow('Module dependent requires enabled module base');
    expect(() => selectModules([module('dependent', ['missing'])])).toThrow('requires enabled module missing');
    expect(() => selectModules([module('a', ['b']), module('b', ['a'])])).toThrow('Circular module dependency');
    expect(() => registerModules(new Hono() as DholeApp, {} as ServerContext, [base, dependent, base])).toThrow('Duplicate module id base');
    expect(base.register).not.toHaveBeenCalled();
    expect(dependent.register).not.toHaveBeenCalled();
  });
});
