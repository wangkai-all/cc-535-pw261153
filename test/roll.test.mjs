import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RollStore } from '../lib/roll.mjs';
import {
  normalizeTickets,
  normalizeRollNo,
  parsePage,
  parseLine,
  parseTicketParams,
} from '../lib/ticket.mjs';

function seed004() {
  const store = new RollStore({ idFactory: () => `HO-T-${Math.random().toString(36).slice(2, 7)}` });
  store.createRoll({ rollNo: 'T-001', pageCount: 4, linesPerPage: 3 });
  return store;
}

function addPage(store, rollNo, page, lines = [1, 2, 3]) {
  return store.importBatch(rollNo, lines.map((line) => ({ page, line })));
}

test('正常：尾页先到、中间页缺失，导入后不完整但可交已确认段', () => {
  const store = seed004();
  addPage(store, 'T-001', 4, [1, 2, 3]);
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 2);
  const view = store.view('T-001');
  assert.equal(view.complete, false);
  assert.deepEqual(view.missingPages, [3]);
  assert.deepEqual(view.confirmedRange, { from: 1, to: 2 });
  assert.equal(view.tailStatus, 'DAMAGED');
  assert.deepEqual(view.arrivalOrder.slice(0, 1), ['4-1']);
});

test('正常：同一页复印两次，按票页去重并统计重复次数', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  const again = store.importBatch('T-001', [
    { page: 1, line: 1 },
    { page: 1, line: 2 },
    { page: 1, line: 3 },
  ]);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 3);
  const view = store.view('T-001');
  assert.equal(view.importedTickets, 3);
  assert.equal(view.duplicateCount, 3);
  assert.deepEqual(
    view.duplicates.map((d) => d.page + '-' + d.line),
    ['1-1', '1-2', '1-3'],
  );
});

test('正常：缺页补齐后完整范围重算，整卷交付成功', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 2);
  addPage(store, 'T-001', 4);
  addPage(store, 'T-001', 3);
  const view = store.view('T-001');
  assert.equal(view.complete, true);
  assert.equal(view.tailStatus, 'SEALED');
  assert.deepEqual(view.confirmedRange, { from: 1, to: 4 });
  const handoff = store.commitDelivery('T-001', { mode: 'complete' });
  assert.equal(handoff.finalized, true);
  assert.equal(handoff.coverage, '1-4');
  assert.equal(handoff.newTickets, 12);
});

test('正常：先交已确认段，补页后整卷交付只补差集，不重复送已清算票页', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 2);
  addPage(store, 'T-001', 4, [1, 2]); // 尾页先到且暂时缺第 3 行

  const first = store.commitDelivery('T-001', { mode: 'confirmed' });
  assert.equal(first.finalized, false);
  assert.equal(first.coverage, '1-2');
  assert.equal(first.newTickets, 6);
  assert.deepEqual(first.newPages, [{ from: 1, to: 2 }]);

  // 第 3 页补上，但第 4 页仍缺行，整卷还不完整
  addPage(store, 'T-001', 3);
  assert.throws(() => store.commitDelivery('T-001', { mode: 'complete' }), (e) => e.code === 'INCOMPLETE_ROLL');

  // 补齐尾页缺行后再整卷交付
  store.importTicket('T-001', { page: 4, line: 3 });
  const final = store.commitDelivery('T-001', { mode: 'complete' });
  assert.equal(final.finalized, true);
  assert.equal(final.coverage, '1-4');
  assert.equal(final.newTickets, 6, '第 3 页和第 4 页此前未清算，6 张票页本次送出');
  assert.equal(final.repeatedTicketsSuppressed, 6, '第 1、2 页已清算，重复拦截');
  assert.deepEqual(final.newPages, [{ from: 3, to: 4 }]);
  assert.equal(final.tailStatus, 'SEALED');
});

test('正常：已确认段重复交付被拒，且不产生新交接单', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 2);
  addPage(store, 'T-001', 3);
  const first = store.commitDelivery('T-001', { mode: 'confirmed' });
  assert.throws(
    () => store.commitDelivery('T-001', { mode: 'confirmed' }),
    (e) => e.code === 'NO_NEW_CONTENT' && e.details.handoffId === first.handoffId,
  );
  assert.equal(store.handoffs.size, 1);
  assert.equal(store.view('T-001').delivery.sentTickets, 9);
});

test('正常：部分交付后补交中间页，只送新增票页并扩宽已清算范围', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 3);
  const first = store.commitDelivery('T-001', { mode: 'confirmed' });
  assert.equal(first.newTickets, 3);

  addPage(store, 'T-001', 2);
  const view = store.view('T-001');
  assert.deepEqual(view.confirmedRange, { from: 1, to: 3 });
  const second = store.commitDelivery('T-001', { mode: 'confirmed' });
  assert.equal(second.newTickets, 6);
  assert.deepEqual(second.newPages, [{ from: 2, to: 3 }]);
  assert.equal(second.repeatedTicketsSuppressed, 3);

  const after = store.view('T-001');
  assert.equal(after.delivery.sentTickets, 9);
  assert.deepEqual(after.delivery.sentPages, [{ from: 1, to: 3 }]);
});

test('正常：卷尾找回后取消丢失标记并登记页数，可整卷交付', () => {
  const store = new RollStore();
  store.createRoll({ rollNo: 'T-002', pageCount: 5, linesPerPage: 3, lastPageLost: true });
  addPage(store, 'T-002', 1);
  addPage(store, 'T-002', 2);
  addPage(store, 'T-002', 3);
  assert.equal(store.view('T-002').tailStatus, 'LOST');
  assert.throws(() => store.commitDelivery('T-002', { mode: 'complete' }), (e) => e.code === 'INCOMPLETE_ROLL');

  const partial = store.commitDelivery('T-002', { mode: 'confirmed' });
  assert.equal(partial.coverage, '1-3');

  // 卷尾找回：第 4、5 页到手，取消丢失标记
  addPage(store, 'T-002', 4);
  addPage(store, 'T-002', 5);
  store.updateRoll('T-002', { lastPageLost: false });
  assert.equal(store.view('T-002').complete, true);

  const final = store.commitDelivery('T-002', { mode: 'complete' });
  assert.equal(final.finalized, true);
  assert.equal(final.newTickets, 6);
  assert.deepEqual(final.newPages, [{ from: 4, to: 5 }]);
});

test('异常：卷尾丢失且未登记页数时，整卷交付报 INCOMPLETE_ROLL，已确认段照常可交', () => {
  const store = new RollStore();
  store.createRoll({ rollNo: 'T-003', lastPageLost: true });
  addPage(store, 'T-003', 1);
  addPage(store, 'T-003', 2);
  const view = store.view('T-003');
  assert.equal(view.tailStatus, 'LOST');
  assert.equal(view.confirmedRange.from, 1);
  assert.equal(view.confirmedRange.to, 2);
  assert.throws(
    () => store.commitDelivery('T-003', { mode: 'complete' }),
    (e) => e.code === 'INCOMPLETE_ROLL' && e.details.confirmedRange.to === 2,
  );
  const partial = store.commitDelivery('T-003', { mode: 'confirmed' });
  assert.equal(partial.finalized, false);
  assert.equal(partial.tailStatus, 'LOST');
});

test('异常：缺页时整卷交付被拒，错误里给出缺页与已确认范围', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  addPage(store, 'T-001', 4);
  assert.throws(
    () => store.commitDelivery('T-001', { mode: 'complete' }),
    (e) =>
      e.code === 'INCOMPLETE_ROLL' &&
      e.details.missingPages.join(',') === '2,3' &&
      e.details.confirmedRange.from === 1,
  );
});

test('异常：首页缺行时没有可确认段，先交已确认段被拒', () => {
  const store = seed004();
  addPage(store, 'T-001', 1, [1, 3]); // 缺第 2 行
  addPage(store, 'T-001', 2);
  assert.throws(
    () => store.commitDelivery('T-001', { mode: 'confirmed' }),
    (e) => e.code === 'NO_CONFIRMED_SEGMENT',
  );
});

test('异常：页码超出登记页数、行号超出登记行数，整批拒绝且不写入', () => {
  const store = seed004();
  assert.throws(
    () => store.importBatch('T-001', [{ page: 1, line: 1 }, { page: 9, line: 1 }]),
    (e) => e.code === 'PAGE_OUT_OF_RANGE',
  );
  assert.throws(
    () => store.importBatch('T-001', [{ page: 1, line: 4 }]),
    (e) => e.code === 'LINE_OUT_OF_RANGE',
  );
  assert.equal(store.view('T-001').importedTickets, 0);
});

test('异常：非法票页参数被拒绝', () => {
  assert.throws(() => normalizeRollNo(' '), (e) => e.code === 'INVALID_ROLL_NO');
  assert.throws(() => normalizeRollNo('bad roll'), (e) => e.code === 'INVALID_ROLL_NO');
  assert.throws(() => parsePage(0), (e) => e.code === 'INVALID_PAGE');
  assert.throws(() => parsePage('1.5'), (e) => e.code === 'INVALID_PAGE');
  assert.throws(() => parseLine(10000), (e) => e.code === 'INVALID_LINE');
  assert.throws(() => parseTicketParams({ rollNo: 'A', page: 'x', line: '1' }), (e) => e.code === 'INVALID_PAGE');
  assert.deepEqual(parseTicketParams({ rollNo: ' A-1 ', page: '2', line: '3' }), { rollNo: 'A-1', page: 2, line: 3 });
});

test('异常：版本冲突类操作——重复建卷、未知卷、空批次、非法模式', () => {
  const store = seed004();
  assert.throws(() => store.createRoll({ rollNo: 'T-001' }), (e) => e.code === 'ROLL_EXISTS');
  assert.throws(() => store.view('NOPE'), (e) => e.code === 'ROLL_NOT_FOUND');
  assert.throws(() => store.importBatch('T-001', []), (e) => e.code === 'EMPTY_BATCH');
  addPage(store, 'T-001', 1);
  assert.throws(
    () => store.commitDelivery('T-001', { mode: 'partial' }),
    (e) => e.code === 'INVALID_MODE',
  );
  assert.throws(() => store.createRoll({ rollNo: 'T-9', pageCount: 0 }), (e) => e.code === 'INVALID_PAGE_COUNT');
});

test('异常：整卷交付后票卷封存，再导入或再交付都被拒', () => {
  const store = seed004();
  for (const page of [1, 2, 3, 4]) addPage(store, 'T-001', page);
  store.commitDelivery('T-001', { mode: 'complete' });
  assert.throws(() => addPage(store, 'T-001', 1), (e) => e.code === 'ROLL_CLOSED');
  assert.throws(
    () => store.commitDelivery('T-001', { mode: 'confirmed' }),
    (e) => e.code === 'ALREADY_FINALIZED',
  );
  assert.throws(() => store.updateRoll('T-001', { note: 'x' }), (e) => e.code === 'ROLL_CLOSED');
});

test('异常：登记页数不能小于已导入页码', () => {
  const store = seed004();
  addPage(store, 'T-001', 4);
  assert.throws(
    () => store.updateRoll('T-001', { pageCount: 3 }),
    (e) => e.code === 'INVALID_PAGE_COUNT' && e.details.pages.join(',') === '4',
  );
});

test('异常：没有任何票页时交付被拒', () => {
  const store = new RollStore();
  store.createRoll({ rollNo: 'T-004', pageCount: 2 });
  assert.throws(() => store.commitDelivery('T-004', { mode: 'confirmed' }), (e) => e.code === 'NOTHING_TO_DELIVER');
});

test('normalizeTickets：乱序输入排序去重，保留最小完整集合', () => {
  const tickets = normalizeTickets([
    { page: 4, line: 2 },
    { page: 1, line: 1 },
    { page: 4, line: 2 },
    { page: 1, line: 1 },
  ]);
  assert.deepEqual(tickets, [
    { page: 1, line: 1 },
    { page: 4, line: 2 },
  ]);
});

test('指纹：相同票页集合生成相同指纹，不同集合不同', () => {
  const store = seed004();
  addPage(store, 'T-001', 1);
  const a = store.commitDelivery('T-001', { mode: 'confirmed' });
  const second = new RollStore();
  second.createRoll({ rollNo: 'T-001', pageCount: 4, linesPerPage: 3 });
  addPage(second, 'T-001', 1);
  const b = second.commitDelivery('T-001', { mode: 'confirmed' });
  assert.equal(a.newTicketFingerprint, b.newTicketFingerprint);
  assert.match(a.newTicketFingerprint, /^[0-9a-f]{8}$/);
});
