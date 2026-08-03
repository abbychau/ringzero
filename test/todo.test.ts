import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createTodoTool, type TodoItem } from '../src/tools/todo.js';
import { planTool } from '../src/tools/plan.js';
import { PLAN_APPROVED, PLAN_REJECTED } from '../src/kernel/types.js';
import type { ToolContext } from '../src/kernel/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

test('todo: add/done/open/clear/list roundtrip and onChange fires', async () => {
  const todos: TodoItem[] = [];
  let changes = 0;
  const tool = createTodoTool(todos, () => changes++);
  assert.equal(await tool.execute({ op: 'list' }, ctx), '(no todos)');
  assert.equal(await tool.execute({ op: 'add', text: 'write tests' }, ctx), '1. [ ] write tests');
  assert.equal(
    await tool.execute({ op: 'add', text: 'commit' }, ctx),
    '1. [ ] write tests\n2. [ ] commit',
  );
  assert.equal(await tool.execute({ op: 'done', n: 1 }, ctx), '1. [x] write tests\n2. [ ] commit');
  assert.equal(await tool.execute({ op: 'open', n: 1 }, ctx), '1. [ ] write tests\n2. [ ] commit');
  assert.deepEqual(todos, [
    { text: 'write tests', done: false },
    { text: 'commit', done: false },
  ]);
  assert.equal(changes, 4, 'list does not persist, mutations do');
  assert.equal(await tool.execute({ op: 'clear' }, ctx), '(no todos)');
  assert.equal(changes, 5);
  assert.equal(todos.length, 0);
});

test('todo: error cases', async () => {
  const todos: TodoItem[] = [{ text: 'a', done: false }];
  const tool = createTodoTool(todos);
  assert.ok((await tool.execute({ op: 'add' }, ctx)).startsWith('error:'));
  assert.ok((await tool.execute({ op: 'done', n: 5 }, ctx)).startsWith('error: n out of range'));
  assert.ok((await tool.execute({ op: 'wat' }, ctx)).startsWith('error: unknown op'));
});

test('plan tool: ask yes approves, ask no rejects, empty plan errors', async () => {
  const yes = await planTool().execute({ plan: 'do the thing' }, ctx);
  assert.equal(yes, PLAN_APPROVED);
  const no = await planTool().execute({ plan: 'do the thing' }, { ...ctx, ask: async () => false });
  assert.equal(no, PLAN_REJECTED);
  const empty = await planTool().execute({ plan: '   ' }, ctx);
  assert.ok(empty.startsWith('error:'));
});
