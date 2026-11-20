const state = {
  rolls: [],
  current: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

const TAIL_LABEL = {
  SEALED: '卷尾已封口',
  DAMAGED: '卷尾残缺',
  LOST: '卷尾丢失',
  UNREGISTERED: '未登记页数',
};

const STATUS_LABEL = {
  CONFIRMED: '已确认段',
  AWAITING_MISSING: '待补页',
};

const MODE_LABEL = {
  complete: '整卷',
  confirmed: '已确认段',
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务器返回了非 JSON 内容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const err = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    err.code = payload?.error?.code ?? 'HTTP_ERROR';
    err.status = response.status;
    err.details = payload?.error?.details ?? {};
    throw err;
  }
  return payload;
}

/** 把卷状态压成可核对的短摘要，供“操作前/操作后”对比。 */
function summarize(roll) {
  if (!roll) return { 状态: '未选择票卷' };
  return {
    卷号: roll.rollNo,
    已导入票页: roll.importedTickets,
    已导入页: roll.pagesPresent.join(',') || '无',
    到达顺序: roll.arrivalOrder.length ? roll.arrivalOrder.join(' → ') : '无',
    缺页: roll.missingPages.join(',') || '无',
    缺行: roll.missingLines.length ? roll.missingLines.map((x) => `${x.page}-${x.line}`).join(',') : '无',
    重复复印: roll.duplicateCount,
    完整: roll.complete ? '是' : '否',
    卷尾: TAIL_LABEL[roll.tailStatus] ?? roll.tailStatus,
    已确认范围: roll.confirmedRange ? `${roll.confirmedRange.from}-${roll.confirmedRange.to}` : '无',
    已清算票页: roll.delivery?.sentTickets ?? 0,
    已清算页: roll.delivery?.sentPages?.length
      ? roll.delivery.sentPages.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',')
      : '无',
    最终交接: roll.finalized ? roll.delivery.handoffId : '未最终交接',
  };
}

function text(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}：${v}`)
    .join('\n');
}

function setEvidence({ result, action, before, after, note }) {
  $('evidence').dataset.evidenceResult = result;
  $('evidence-action').textContent = action;
  $('evidence-before').textContent = before ?? '—';
  $('evidence-after').textContent = after ?? '—';
  $('evidence-note').textContent = note ?? '';
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['btn-import', 'btn-supplement', 'btn-deliver', 'btn-handoff', 'create-roll-form']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  $('server-state').textContent = busy ? '本地样例 · 处理中' : '本地样例 · 已连接';
}

async function loadRolls(selectRollNo) {
  const { rolls = [] } = await api('/api/rolls');
  state.rolls = rolls;
  if (selectRollNo) state.current = selectRollNo;
  if (!state.current || !rolls.some((r) => r.rollNo === state.current)) {
    state.current = rolls[0]?.rollNo ?? null;
  }
  renderRollList();
  renderCurrent();
}

function renderRollList() {
  const list = $('roll-list');
  list.replaceChildren();
  for (const roll of state.rolls) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `roll-item${roll.rollNo === state.current ? ' active' : ''}`;
    btn.setAttribute('aria-current', roll.rollNo === state.current ? 'true' : 'false');
    btn.onclick = () => {
      state.current = roll.rollNo;
      renderRollList();
      renderCurrent();
      setEvidence({
        result: 'idle',
        action: '已切换票卷',
        before: text(summarize(roll)),
        after: text(summarize(roll)),
        note: `当前票卷 ${roll.rollNo}；执行操作后这里会显示前后差异。`,
      });
    };
    const title = document.createElement('span');
    title.className = 'roll-no';
    title.textContent = roll.rollNo;
    const meta = document.createElement('span');
    meta.className = 'roll-meta';
    meta.textContent = `${roll.importedTickets} 票页 · ${roll.complete ? '完整' : `${roll.missingPages.length} 页缺口`} · ${
      TAIL_LABEL[roll.tailStatus] ?? roll.tailStatus
    }`;
    const badge = document.createElement('span');
    badge.className = `badge ${roll.finalized ? 'ok' : roll.confirmedRange ? 'warn' : 'muted'}`;
    badge.textContent = roll.finalized ? '已最终交接' : roll.delivery ? '已交已确认段' : '未交付';
    btn.append(title, meta, badge);
    li.append(btn);
    list.append(li);
  }
}

function currentRoll() {
  return state.rolls.find((r) => r.rollNo === state.current) ?? null;
}

function renderCurrent() {
  const roll = currentRoll();
  const title = $('current-roll-title');
  const sub = $('current-roll-sub');
  if (!roll) {
    title.textContent = '未选择票卷';
    sub.textContent = '从左侧选择一卷，或建立新卷。';
    $('tail-pill').textContent = '—';
    delete $('tail-pill').dataset.state;
    $('roll-stats').replaceChildren();
    $('segments').replaceChildren();
    $('handoffs').replaceChildren();
    return;
  }
  title.textContent = roll.rollNo;
  sub.textContent = roll.note || '无备注';
  $('tail-pill').textContent = TAIL_LABEL[roll.tailStatus] ?? roll.tailStatus;
  $('tail-pill').dataset.state = roll.tailStatus;
  syncPatchForm(roll);
  renderStats(roll);
  renderSegments(roll);
  renderHandoffs(roll);
  $('segment-note').textContent = roll.segments.length
    ? `共 ${roll.segments.length} 段；已确认 ${roll.confirmedRange ? `${roll.confirmedRange.from}-${roll.confirmedRange.to}` : '无'}`
    : '还没有导入票页';
  $('handoff-note').textContent = roll.delivery
    ? `最近交接 ${roll.delivery.handoffId} · ${MODE_LABEL[roll.delivery.mode]}`
    : '尚未交付';
}

function renderStats(roll) {
  const stats = [
    ['登记页数', roll.pageCount ?? '未登记'],
    ['每页行数', roll.linesPerPage ?? '按扫描推断'],
    ['已导入票页', roll.importedTickets],
    ['已导入页', roll.pagesPresent.length],
    ['重复复印', roll.duplicateCount],
    ['缺页', roll.missingPages.length],
    ['缺行', roll.missingLines.length],
    ['已清算票页', roll.delivery?.sentTickets ?? 0],
  ];
  const grid = $('roll-stats');
  grid.replaceChildren();
  for (const [label, value] of stats) {
    const div = document.createElement('div');
    div.className = 'stat';
    const dt = document.createElement('span');
    dt.className = 'stat-label';
    dt.textContent = label;
    const dd = document.createElement('strong');
    dd.className = 'stat-value';
    dd.textContent = String(value);
    div.append(dt, dd);
    grid.append(div);
  }
}

function syncPatchForm(roll) {
  $('patch-page-count').value = roll.pageCount ?? '';
  $('patch-lines-per-page').value = roll.linesPerPage ?? '';
  $('patch-last-page-lost').checked = roll.lastPageLost;
}

function renderSegments(roll) {
  const root = $('segments');
  root.replaceChildren();
  if (roll.segments.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '导入票页后，按页码连续段展示。';
    root.append(p);
    return;
  }
  for (const seg of roll.segments) {
    const card = document.createElement('article');
    card.className = `segment ${seg.status === 'CONFIRMED' ? 'confirmed' : 'pending'}`;
    const head = document.createElement('div');
    head.className = 'segment-head';
    const range = document.createElement('strong');
    range.textContent = seg.from === seg.to ? `第 ${seg.from} 页` : `第 ${seg.from}-${seg.to} 页`;
    const status = document.createElement('span');
    status.className = 'tag';
    status.textContent = STATUS_LABEL[seg.status] ?? seg.status;
    head.append(range, status);
    if (seg.sent) {
      const sent = document.createElement('span');
      sent.className = 'tag ok';
      sent.textContent = '已清算';
      head.append(sent);
    } else if (seg.sentTickets > 0) {
      const part = document.createElement('span');
      part.className = 'tag warn';
      part.textContent = `部分清算 ${seg.sentTickets}/${seg.ticketCount}`;
      head.append(part);
    }
    const body = document.createElement('p');
    body.className = 'segment-body';
    body.textContent = `${seg.ticketCount} 票页 · 页 ${seg.pages.join(',')} · 卷尾 ${seg.tail ?? '—'}${
      seg.gapCount ? ` · 缺 ${seg.gapCount} 行（${seg.gaps.map((g) => `${g.page}-${g.line}`).join('、')}${seg.gapCount > seg.gaps.length ? '…' : ''}）` : ''
    }`;
    card.append(head, body);
    root.append(card);
  }
}

function renderHandoffs(roll) {
  const root = $('handoffs');
  root.replaceChildren();
  const history = roll.delivery?.history ?? [];
  if (history.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '还没有清算交接记录。';
    root.append(p);
    return;
  }
  for (const h of [...history].reverse()) {
    const li = document.createElement('li');
    li.className = 'handoff';
    const title = document.createElement('div');
    title.className = 'handoff-title';
    title.textContent = `${h.handoffId} · ${MODE_LABEL[h.mode]} · ${h.coverage}`;
    const meta = document.createElement('div');
    meta.className = 'handoff-meta';
    meta.textContent = `新增 ${h.newTickets} 票页；重复拦截 ${h.repeatedTicketsSuppressed} 票页；范围 ${h.range.from}-${h.range.to}；新页 ${h.newPages.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',') || '无'}`;
    const note = document.createElement('div');
    note.className = 'handoff-note';
    note.textContent = `${h.note}${h.finalized ? '（最终）' : ''}`;
    li.append(title, meta, note);
    root.append(li);
  }
}

function mode() {
  return document.querySelector('input[name="delivery-mode"]:checked')?.value ?? 'complete';
}

function parsePageText(raw) {
  const tickets = [];
  const errors = [];
  raw.split(/\r?\n/u).forEach((line, index) => {
    const item = line.trim();
    if (!item) return;
    const m = /^(\d{1,4})\s*[-,\s:]\s*(\d{1,4})$/u.exec(item);
    if (!m) {
      errors.push(`第 ${index + 1} 行无法识别：${item}`);
      return;
    }
    tickets.push({ page: Number(m[1]), line: Number(m[2]) });
  });
  if (errors.length) throw new Error(errors.join('；'));
  if (tickets.length === 0) throw new Error('清单为空，请至少填写一页');
  return tickets;
}

async function runOperation(action, fn) {
  if (state.busy) return;
  if (!state.current) {
    setEvidence({
      result: 'NO_ROLL',
      action,
      before: '未选择票卷',
      after: '未选择票卷',
      note: '请先从左侧选择票卷。',
    });
    return;
  }
  const before = summarize(currentRoll());
  setBusy(true);
  try {
    const outcome = await fn();
    await loadRolls(state.current);
    setEvidence({
      result: `${outcome.code}:OK`,
      action,
      before: text(before),
      after: text(summarize(currentRoll())),
      note: outcome.note,
    });
  } catch (error) {
    // 失败时也刷新一次，确保“操作后”反映服务器真实状态（失败通常不写入）。
    try {
      await loadRolls(state.current);
    } catch {
      /* 保持旧视图 */
    }
    setEvidence({
      result: `${action}:${error.code ?? 'ERROR'}`,
      action: `${action} · 被拒绝`,
      before: text(before),
      after: text(summarize(currentRoll())),
      note: `[${error.code ?? 'ERROR'}] ${error.message}`,
    });
  } finally {
    setBusy(false);
  }
}

function sampleForCurrent() {
  const roll = currentRoll();
  if (!roll) return '';
  const page = (roll.pageCount ?? Math.max(1, ...roll.pagesPresent, 1)) + 0;
  const lines = roll.linesPerPage ?? 3;
  const target = roll.missingPages[0] ?? page;
  return Array.from({ length: lines }, (_, i) => `${target}-${i + 1}`).join('\n');
}

function gapsForCurrent() {
  const roll = currentRoll();
  if (!roll) return '';
  const entries = [];
  for (const page of roll.missingPages.slice(0, 3)) {
    const lines = roll.linesPerPage ?? 3;
    for (let line = 1; line <= lines; line += 1) entries.push(`${page}-${line}`);
  }
  for (const gap of roll.missingLines) entries.push(`${gap.page}-${gap.line}`);
  return [...new Set(entries)].join('\n');
}

function wire() {
  $('reload-rolls').onclick = () => runOperation('REFRESH', async () => {
    await loadRolls(state.current);
    return { code: 'REFRESH', note: '已从服务器重新读取票卷列表。' };
  });

  $('create-roll-form').onsubmit = (event) => {
    event.preventDefault();
    const rollNo = $('new-roll-no').value.trim();
    const pageCount = $('new-page-count').value.trim();
    const linesPerPage = $('new-lines-per-page').value.trim();
    const lastPageLost = $('new-last-page-lost').checked;
    runOperation('CREATE_ROLL', async () => {
      const created = await api('/api/rolls', {
        method: 'POST',
        body: JSON.stringify({
          rollNo,
          pageCount: pageCount === '' ? null : Number(pageCount),
          linesPerPage: linesPerPage === '' ? null : Number(linesPerPage),
          lastPageLost,
        }),
      });
      await loadRolls(created.roll.rollNo);
      return { code: 'CREATE_ROLL', note: `已建立票卷 ${created.roll.rollNo}。` };
    });
  };

  $('btn-import').onclick = () => {
    const raw = $('import-text').value;
    runOperation('IMPORT_PAGES', async () => {
      const tickets = parsePageText(raw);
      const result = await api(`/api/rolls/${encodeURIComponent(state.current)}/pages`, {
        method: 'POST',
        body: JSON.stringify({ tickets }),
      });
      return {
        code: 'IMPORT_PAGES',
        note: `导入 ${result.imported} 票页，重复复印 ${result.duplicates} 票页已去重。完整范围重算后完整=${result.roll.complete ? '是' : '否'}。`,
      };
    });
  };

  $('btn-fill-sample').onclick = () => {
    $('import-text').value = sampleForCurrent();
  };

  $('btn-supplement').onclick = () => {
    const raw = $('supplement-text').value;
    runOperation('SUPPLEMENT_PAGES', async () => {
      const tickets = parsePageText(raw);
      const result = await api(`/api/rolls/${encodeURIComponent(state.current)}/pages`, {
        method: 'POST',
        body: JSON.stringify({ tickets }),
      });
      return {
        code: 'SUPPLEMENT_PAGES',
        note: `补交 ${result.imported} 票页，重复 ${result.duplicates} 票页已拦截。已清算票页不会被重复送。`,
      };
    });
  };

  $('btn-fill-gaps').onclick = () => {
    $('supplement-text').value = gapsForCurrent();
  };

  $('btn-patch').onclick = () => {
    const rawCount = $('patch-page-count').value.trim();
    const rawLines = $('patch-lines-per-page').value.trim();
    const lastPageLost = $('patch-last-page-lost').checked;
    runOperation('UPDATE_ROLL', async () => {
      const body = { lastPageLost };
      if (rawCount !== '') body.pageCount = Number(rawCount);
      if (rawLines !== '') body.linesPerPage = Number(rawLines);
      const result = await api(`/api/rolls/${encodeURIComponent(state.current)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return {
        code: 'UPDATE_ROLL',
        note: `登记已更正：完整=${result.roll.complete ? '是' : '否'}，卷尾 ${TAIL_LABEL[result.roll.tailStatus] ?? result.roll.tailStatus}，已确认范围 ${
          result.roll.confirmedRange ? `${result.roll.confirmedRange.from}-${result.roll.confirmedRange.to}` : '无'
        }。`,
      };
    });
  };

  $('btn-deliver').onclick = () => {
    const chosen = mode();
    runOperation('DELIVER', async () => {
      const result = await api(`/api/rolls/${encodeURIComponent(state.current)}/deliveries`, {
        method: 'POST',
        body: JSON.stringify({ mode: chosen }),
      });
      return {
        code: 'DELIVER',
        note: `${result.handoff.handoffId}：${result.handoff.note}；新增 ${result.handoff.newTickets} 票页，重复拦截 ${result.handoff.repeatedTicketsSuppressed} 票页。`,
      };
    });
  };

  $('btn-handoff').onclick = () => {
    runOperation('VIEW_HANDOFF', async () => {
      const result = await api(`/api/rolls/${encodeURIComponent(state.current)}/handoff`);
      if (!result.handoff) {
        return { code: 'VIEW_HANDOFF', note: '这一卷还没有清算交接记录。' };
      }
      const h = result.handoff;
      return {
        code: 'VIEW_HANDOFF',
        note: `最近交接 ${h.handoffId}，覆盖 ${h.coverage}，新增 ${h.newTickets} 票页，重复拦截 ${h.repeatedTicketsSuppressed}，指纹 ${h.newTicketFingerprint}。`,
      };
    });
  };
}

async function boot() {
  wire();
  try {
    await loadRolls();
    $('server-state').textContent = '本地样例 · 已连接';
  } catch (error) {
    $('server-state').textContent = '本地样例 · 连接失败';
    setEvidence({
      result: 'BOOT:ERROR',
      action: '初始化失败',
      before: '—',
      after: '—',
      note: error.message,
    });
  }
}

boot();
