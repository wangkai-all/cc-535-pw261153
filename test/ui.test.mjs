import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
const appSource = await readFile(path.join(ROOT, 'public/app.js'), 'utf8');
const IDS = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

function makeElement(id) {
  const el = {
    id,
    children: [],
    dataset: {},
    value: '',
    checked: false,
    textContent: '',
    disabled: false,
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute() {},
  };
  return el;
}

/** 用最小 DOM 桩加载 app.js，返回页面元素与调用按钮的能力。 */
function bootApp({ roll, onRequest }) {
  const elements = new Map(IDS.map((id) => [id, makeElement(id)]));
  elements.get('evidence').dataset.evidenceResult = 'idle';
  let sequence = 0;
  const context = {
    document: {
      getElementById: (id) => elements.get(id) ?? null,
      querySelector: (sel) => (sel.includes('delivery-mode') ? { value: 'complete' } : null),
      createElement: () => makeElement(`generated-${++sequence}`),
    },
    fetch: async (url, options = {}) =>
      onRequest(url, options.body ? JSON.parse(options.body) : undefined),
    setTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: 'app.js' });
  return { elements, context };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function baseRoll(overrides = {}) {
  return {
    rollNo: 'UI-001',
    pageCount: 2,
    linesPerPage: 1,
    lastPageLost: false,
    note: '',
    importedTickets: 1,
    importedPages: 1,
    duplicateCount: 0,
    duplicates: [],
    pagesPresent: [1],
    missingPages: [2],
    missingLines: [],
    complete: false,
    coverage: '1-1',
    confirmedRange: { from: 1, to: 1 },
    tailStatus: 'DAMAGED',
    arrivalOrder: ['1-1'],
    segments: [],
    delivery: null,
    handoff: null,
    finalized: false,
    tickets: [],
    ...overrides,
  };
}

test('页面：三组动作按钮与 data-evidence-result 契约齐全', () => {
  const evidence = /<section[^>]*data-evidence-result="idle"/s.test(html);
  assert.equal(evidence, true);
  for (const label of ['导入不完整票卷', '补交中间页', '查看清算交接']) {
    assert.ok(html.includes(label), `缺少按钮文案：${label}`);
  }
  for (const id of ['evidence-before', 'evidence-after', 'evidence-action', 'evidence-note']) {
    assert.ok(IDS.includes(id), `缺少核对元素：${id}`);
  }
});

test('页面：整卷交付被拒时，结果区标出错误码且前后两栏都可核对', async () => {
  let roll = baseRoll();
  const { elements } = bootApp({
    roll,
    onRequest(url, body) {
      if (url.endsWith('/deliveries')) {
        assert.equal(body.mode, 'complete');
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: { code: 'INCOMPLETE_ROLL', message: '还缺 1 页（2）', details: {} },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ rolls: [roll], roll }) });
    },
  });
  await tick();
  elements.get('btn-deliver').onclick();
  await tick();

  assert.equal(elements.get('evidence').dataset.evidenceResult, 'DELIVER:INCOMPLETE_ROLL');
  assert.match(elements.get('evidence-note').textContent, /INCOMPLETE_ROLL/);
  assert.match(elements.get('evidence-before').textContent, /完整：否/);
  assert.match(elements.get('evidence-after').textContent, /完整：否/);
  assert.match(elements.get('evidence-before').textContent, /缺页：2/);
});

test('页面：补页后整卷交付成功，操作前不完整、操作后完整且展示交接单', async () => {
  let roll = baseRoll();
  const handoff = {
    handoffId: 'HO-UI-1',
    mode: 'complete',
    complete: true,
    range: { from: 1, to: 2 },
    coverage: '1-2',
    newTickets: 1,
    newPages: [{ from: 2, to: 2 }],
    repeatedTicketsSuppressed: 1,
    note: '整卷已确认完整',
    finalized: true,
  };
  const { elements } = bootApp({
    roll,
    onRequest(url) {
      if (url.endsWith('/deliveries')) {
        roll = baseRoll({
          importedTickets: 2,
          importedPages: 2,
          pagesPresent: [1, 2],
          missingPages: [],
          complete: true,
          tailStatus: 'SEALED',
          confirmedRange: { from: 1, to: 2 },
          finalized: true,
          handoff,
          delivery: { handoffId: 'HO-UI-1', finalized: true, mode: 'complete', coverage: '1-2', sentTickets: 2, sentPages: [{ from: 1, to: 2 }], history: [handoff] },
        });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ handoff, roll }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ rolls: [roll], roll }) });
    },
  });
  await tick();
  elements.get('btn-deliver').onclick();
  await tick();

  assert.equal(elements.get('evidence').dataset.evidenceResult, 'DELIVER:OK');
  assert.match(elements.get('evidence-before').textContent, /完整：否/);
  assert.match(elements.get('evidence-after').textContent, /完整：是/);
  assert.match(elements.get('evidence-after').textContent, /最终交接：HO-UI-1/);
  assert.equal(elements.get('handoffs').children.length, 1);
});

test('页面：查看清算交接在无记录时给出明确提示，而不是空结果', async () => {
  const roll = baseRoll();
  const { elements } = bootApp({
    roll,
    onRequest: (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/handoff') ? { handoff: null, roll } : { rolls: [roll], roll },
      }),
  });
  await tick();
  elements.get('btn-handoff').onclick();
  await tick();
  assert.equal(elements.get('evidence').dataset.evidenceResult, 'VIEW_HANDOFF:OK');
  assert.match(elements.get('evidence-note').textContent, /还没有清算交接记录/);
});
