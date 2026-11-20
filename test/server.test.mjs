import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, seedSamples } from '../server.js';
import { RollStore } from '../lib/roll.mjs';

/** 每个测试用独立 app，避免共享内存串状态。 */
async function startApp({ seed = false } = {}) {
  const server = createApp({ seed });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, body: payload, headers: response.headers };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { server, base, request, stop };
}

test('HTTP：页面与静态资源可访问，业务结果区带 data-evidence-result', async () => {
  const app = await startApp();
  after(app.stop);

  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-evidence-result="idle"/);
  assert.match(html, /导入不完整票卷/);
  assert.match(html, /补交中间页/);
  assert.match(html, /查看清算交接/);

  const js = await fetch(`${app.base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const css = await fetch(`${app.base}/styles.css`);
  assert.equal(css.status, 200);
});

test('HTTP：健康检查与样例卷列表', async () => {
  const app = await startApp({ seed: true });
  after(app.stop);

  const health = await app.request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const rolls = await app.request('GET', '/api/rolls');
  assert.equal(rolls.status, 200);
  assert.deepEqual(
    rolls.body.rolls.map((r) => r.rollNo),
    ['RM-2024-001', 'RM-2024-002', 'RM-2024-003'],
  );
  const r1 = rolls.body.rolls[0];
  assert.equal(r1.complete, false);
  assert.deepEqual(r1.missingPages, [3]);
  assert.equal(r1.tailStatus, 'DAMAGED');
  assert.equal(rolls.body.rolls[1].tailStatus, 'LOST');
  assert.equal(rolls.body.rolls[2].complete, true);
});

test('HTTP：完整流程——导入不完整卷 → 补交中间页 → 整卷交接', async () => {
  const app = await startApp();
  after(app.stop);

  let r = await app.request('POST', '/api/rolls', {
    rollNo: 'H-001',
    pageCount: 3,
    linesPerPage: 2,
  });
  assert.equal(r.status, 201);

  // 先到尾页，再补前面的页，模拟真实扫描顺序
  r = await app.request('POST', '/api/rolls/H-001/pages', {
    tickets: [
      { page: 3, line: 1 },
      { page: 3, line: 2 },
      { page: 1, line: 1 },
      { page: 1, line: 2 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.roll.confirmedRange.to, 1);
  // 整卷交付被拒
  r = await app.request('POST', '/api/rolls/H-001/deliveries', { mode: 'complete' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INCOMPLETE_ROLL');
  assert.deepEqual(r.body.error.details.missingPages, [2]);

  // 先交已确认段
  r = await app.request('POST', '/api/rolls/H-001/deliveries', { mode: 'confirmed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff.coverage, '1-1');
  assert.equal(r.body.handoff.newTickets, 2);
  assert.equal(r.body.roll.delivery.sentTickets, 2);

  // 补交中间页
  r = await app.request('POST', '/api/rolls/H-001/pages', {
    tickets: [
      { page: 2, line: 1 },
      { page: 2, line: 2 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.roll.complete, true);
  assert.deepEqual(r.body.roll.confirmedRange, { from: 1, to: 3 });

  // 整卷交接：只补第 2、3 页
  r = await app.request('POST', '/api/rolls/H-001/deliveries', { mode: 'complete' });
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff.finalized, true);
  assert.equal(r.body.handoff.newTickets, 4);
  assert.equal(r.body.handoff.repeatedTicketsSuppressed, 2);

  // 查看交接
  r = await app.request('GET', '/api/rolls/H-001/handoff');
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff.newTickets, 4);
  assert.equal(r.body.roll.finalized, true);
});

test('HTTP：单页导入接口允许尾页先到，重复导入返回 duplicate=true', async () => {
  const app = await startApp();
  after(app.stop);
  await app.request('POST', '/api/rolls', { rollNo: 'H-002', pageCount: 2, linesPerPage: 1 });

  let r = await app.request('PUT', '/api/rolls/H-002/pages/2/lines/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, false);
  assert.equal(r.body.roll.arrivalOrder[0], '2-1');

  r = await app.request('PUT', '/api/rolls/H-002/pages/2/lines/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.roll.duplicateCount, 1);
});

test('HTTP：非法输入返回 4xx 与稳定错误码', async () => {
  const app = await startApp();
  after(app.stop);
  await app.request('POST', '/api/rolls', { rollNo: 'H-003', pageCount: 2, linesPerPage: 1 });

  let r = await app.request('POST', '/api/rolls/H-003/pages', { tickets: [{ page: 9, line: 1 }] });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PAGE_OUT_OF_RANGE');

  r = await app.request('PUT', '/api/rolls/H-003/pages/x/lines/1');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_PAGE');

  r = await app.request('POST', '/api/rolls/H-003/deliveries', { mode: 'bogus' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_MODE');

  r = await app.request('POST', '/api/rolls/H-003/deliveries', { mode: 'complete' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NOTHING_TO_DELIVER');

  r = await app.request('GET', '/api/rolls/NOPE');
  assert.equal(r.status, 404);

  r = await app.request('GET', '/api/not-there');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');

  // 非 JSON 请求体
  const raw = await fetch(`${app.base}/api/rolls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(raw.status, 400);
  assert.equal((await raw.json()).error.code, 'INVALID_JSON');

  // 静态资源不接受 POST
  const badMethod = await fetch(`${app.base}/`, { method: 'POST' });
  assert.equal(badMethod.status, 405);
});

test('HTTP：卷尾丢失时整卷交付 409，已确认段 200；找回后可整卷交付', async () => {
  const app = await startApp();
  after(app.stop);
  await app.request('POST', '/api/rolls', {
    rollNo: 'H-004',
    pageCount: 3,
    linesPerPage: 1,
    lastPageLost: true,
  });
  await app.request('POST', '/api/rolls/H-004/pages', {
    tickets: [
      { page: 1, line: 1 },
      { page: 2, line: 1 },
    ],
  });

  let r = await app.request('POST', '/api/rolls/H-004/deliveries', { mode: 'complete' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INCOMPLETE_ROLL');
  assert.match(r.body.error.message, /卷尾/);

  r = await app.request('POST', '/api/rolls/H-004/deliveries', { mode: 'confirmed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff.tailStatus, 'LOST');

  // 卷尾找回
  r = await app.request('PATCH', '/api/rolls/H-004', { lastPageLost: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.roll.complete, false, '第 3 页还没扫到');

  await app.request('POST', '/api/rolls/H-004/pages', { tickets: [{ page: 3, line: 1 }] });
  r = await app.request('POST', '/api/rolls/H-004/deliveries', { mode: 'complete' });
  assert.equal(r.status, 200);
  assert.equal(r.body.handoff.finalized, true);
  assert.equal(r.body.handoff.newTickets, 1);

  // 封存后继续导入 / 交付都被拒
  r = await app.request('POST', '/api/rolls/H-004/pages', { tickets: [{ page: 1, line: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ROLL_CLOSED');
  r = await app.request('POST', '/api/rolls/H-004/deliveries', { mode: 'confirmed' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_FINALIZED');
});

test('HTTP：已确认段重复交付 409 NO_NEW_CONTENT，并保留原交接单号', async () => {
  const app = await startApp();
  after(app.stop);
  await app.request('POST', '/api/rolls', { rollNo: 'H-005', pageCount: 2, linesPerPage: 1 });
  await app.request('POST', '/api/rolls/H-005/pages', {
    tickets: [
      { page: 1, line: 1 },
      { page: 2, line: 1 },
    ],
  });
  const first = await app.request('POST', '/api/rolls/H-005/deliveries', { mode: 'confirmed' });
  assert.equal(first.status, 200);

  const again = await app.request('POST', '/api/rolls/H-005/deliveries', { mode: 'confirmed' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'NO_NEW_CONTENT');
  assert.equal(again.body.error.details.handoffId, first.body.handoff.handoffId);
});

test('HTTP：静态页面不含外部依赖', async () => {
  const app = await startApp();
  after(app.stop);
  const html = await (await fetch(`${app.base}/`)).text();
  assert.equal(/https?:\/\//.test(html), false, '页面不应引用外部服务');
  const js = await (await fetch(`${app.base}/app.js`)).text();
  assert.equal(/fetch\(\s*["'`]https?:/.test(js), false);
});

test('seedSamples 幂等：重复调用不会重复建卷或叠加导入', () => {
  const store = new RollStore();
  seedSamples(store);
  const before = store.view('RM-2024-001').importedTickets;
  seedSamples(store);
  assert.equal(store.rolls.size, 3);
  assert.equal(store.view('RM-2024-001').importedTickets, before);
});
