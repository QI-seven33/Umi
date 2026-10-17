import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from '../packages/agent/src/tools/registry.js';
import { installToolModules, toolModule } from '../packages/agent/src/tools/modules.js';
import { hostContext } from '../packages/adapters/src/host-files/scratch.js';

function module(id: string, name: string, requires: string[] = [], created?: () => void) {
  return toolModule(id, '1.0.0', requires, (r) => {
    created?.();
    r.register({
      name,
      description: name,
      schema: z.object({}).strict(),
      effect: 'read',
      prepare: hostContext,
      async execute() {
        return { outcome: 'succeeded', content: name, data: null };
      },
    });
  });
}
test('模块组装：按依赖排序发布工具与不可变描述', () => {
  const registry = new ToolRegistry(),
    order: string[] = [];
  const manifests = installToolModules(registry, [
    module('edit', 'edit', ['files'], () => order.push('edit')),
    module('files', 'read', [], () => order.push('files')),
  ]);
  assert.deepEqual(order, ['files', 'edit']);
  assert.deepEqual(
    manifests.map((m) => m.id),
    order,
  );
  assert.deepEqual(manifests[1]!.tools, ['edit']);
  assert(Object.isFrozen(manifests));
  assert(Object.isFrozen(manifests[1]!.requires));
  assert.equal(registry.get('edit').effect, 'read');
});
for (const mode of ['missing', 'cycle', 'id-conflict'] as const) {
  test(`模块组装：${mode} 在调用工厂前拒绝`, () => {
    const registry = new ToolRegistry();
    let created = 0;
    const a = module('a', 'a', mode === 'id-conflict' ? [] : ['b'], () => created++);
    const others =
      mode === 'missing'
        ? []
        : [module(mode === 'id-conflict' ? 'a' : 'b', 'b', ['a'], () => created++)];
    assert.throws(() => installToolModules(registry, [a, ...others]));
    assert.equal(created, 0);
    assert.equal(registry.specs().length, 0);
  });
}
test('模块组装：工具重名或工厂失败不发布半套工具', () => {
  for (const mode of ['name', 'factory'] as const) {
    const registry = new ToolRegistry();
    installToolModules(registry, [module('base', 'existing')]);
    const second =
      mode === 'name'
        ? module('b', 'existing')
        : toolModule('b', '1.0.0', [], () => {
            throw new Error('工厂失败');
          });
    assert.throws(() => installToolModules(registry, [module('a', 'new'), second]));
    assert.deepEqual(
      registry.specs().map((s) => s.name),
      ['existing'],
    );
  }
});
