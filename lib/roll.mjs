// 票卷状态机。纯内存、同步逻辑，不依赖 HTTP 与 I/O，便于 node --test。
//
// 规则：
// 1. 扫票进程可以乱序交付（先到尾页很常见），导入时按 (页码, 行号) 去重。
// 2. 拼卷进程只交“已确认段”：从第 1 页起连续、且每页行号齐全。
//    登记了每页行数时以登记值为准；否则以该页扫到的最大行号推断。
// 3. 缺页补上后自动重算完整范围。
// 4. 清算端按票页记账（页码+行号），已清算的票页绝不重复送；
//    页区间会显示“已送”，但补交只送新增票页。
// 5. 卷尾丢失：不宣称完整，只能交已确认段，并标出 tailStatus = LOST。
// 6. 整卷交付是最终交接，之后禁止再导入或再交付。
// 7. 同一票页的重复复印只入库一次，并累计重复次数。

import { BusinessError } from './errors.mjs';
import { normalizeRollNo, normalizeTickets } from './ticket.mjs';

export { BusinessError };

function compareTicket(a, b) {
  return a.page - b.page || a.line - b.line;
}

function keyOf(t) {
  return `${t.page}:${t.line}`;
}

function mergeRanges(ranges) {
  const sorted = ranges.map((r) => ({ ...r })).sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

/** 把页码列表压缩成区间，例如 [1,2,4] -> [{from:1,to:2},{from:4,to:4}]。 */
export function pagesToRanges(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out = [];
  for (const page of sorted) {
    const last = out[out.length - 1];
    if (last && page === last.to + 1) last.to = page;
    else out.push({ from: page, to: page });
  }
  return out;
}

export function formatRanges(ranges) {
  return ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(',');
}

export function fingerprint(tickets) {
  // FNV-1a 32 位，纯同步、可重现，用于核对交付内容。
  const text = tickets.map((t) => `${t.page}-${t.line}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export class RollStore {
  /** @param {{idFactory?: () => string}} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, any>} */
    this.rolls = new Map();
    /** @type {Map<string, any>} */
    this.handoffs = new Map();
    let seq = 0;
    this.idFactory = opts.idFactory ?? (() => `HO-${String(++seq).padStart(4, '0')}`);
  }

  getRoll(rollNo) {
    const roll = this.rolls.get(rollNo);
    if (!roll) throw new BusinessError('ROLL_NOT_FOUND', `找不到票卷 ${rollNo}`, { rollNo });
    return roll;
  }

  createRoll({ rollNo, pageCount = null, linesPerPage = null, lastPageLost = false, note = '' } = {}) {
    const id = normalizeRollNo(rollNo);
    if (this.rolls.has(id)) {
      throw new BusinessError('ROLL_EXISTS', `票卷 ${id} 已存在，请换一个卷号`, { rollNo: id });
    }
    const count = this.#optionalCount(pageCount, 'INVALID_PAGE_COUNT', '页码数');
    const lineCount = this.#optionalCount(linesPerPage, 'INVALID_LINE_COUNT', '每页行数');
    if (typeof lastPageLost !== 'boolean') {
      throw new BusinessError('INVALID_FLAG', 'lastPageLost 必须是布尔值');
    }
    if (typeof note !== 'string' || note.length > 500) {
      throw new BusinessError('INVALID_NOTE', '备注需为不超过 500 字的文本');
    }
    const roll = {
      rollNo: id,
      pageCount: count,
      linesPerPage: lineCount,
      lastPageLost,
      note: note.trim(),
      tickets: new Map(),
      duplicates: new Map(), // (page,line) -> 累计出现次数
      arrivals: [], // 扫票到达顺序，用于展示“尾页先到”
      delivery: null,
      createdAt: new Date().toISOString(),
    };
    this.rolls.set(id, roll);
    this.recompute(roll);
    return roll;
  }

  #optionalCount(value, code, label) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > 9999) {
      throw new BusinessError(code, `${label}需为 1-9999 的整数或留空`, { value });
    }
    return n;
  }

  /**
   * 更正卷级登记（页码数、每页行数、卷尾标记、备注）。
   * 用于“卷尾页找回”后取消丢失标记并登记总页数，或补登记页数。
   * 不会改动已导入票页，也不会撤销已清算记录。
   */
  updateRoll(rollNo, patch = {}) {
    const roll = this.getRoll(rollNo);
    this.#assertOpen(roll);
    const next = {
      pageCount: roll.pageCount,
      linesPerPage: roll.linesPerPage,
      lastPageLost: roll.lastPageLost,
      note: roll.note,
    };
    if ('pageCount' in patch) {
      next.pageCount = this.#optionalCount(patch.pageCount, 'INVALID_PAGE_COUNT', '页码数');
    }
    if ('linesPerPage' in patch) {
      next.linesPerPage = this.#optionalCount(patch.linesPerPage, 'INVALID_LINE_COUNT', '每页行数');
    }
    if ('lastPageLost' in patch) {
      if (typeof patch.lastPageLost !== 'boolean') {
        throw new BusinessError('INVALID_FLAG', 'lastPageLost 必须是布尔值');
      }
      next.lastPageLost = patch.lastPageLost;
    }
    if ('note' in patch) {
      if (typeof patch.note !== 'string' || patch.note.length > 500) {
        throw new BusinessError('INVALID_NOTE', '备注需为不超过 500 字的文本');
      }
      next.note = patch.note.trim();
    }
    if (next.pageCount !== null) {
      const beyond = [...roll.tickets.values()].filter((t) => t.page > next.pageCount);
      if (beyond.length > 0) {
        const pages = [...new Set(beyond.map((t) => t.page))].sort((a, b) => a - b);
        throw new BusinessError(
          'INVALID_PAGE_COUNT',
          `已导入第 ${pages.join('、')} 页，登记页数不能小于已导入页码`,
          { pageCount: next.pageCount, pages },
        );
      }
    }
    if (next.linesPerPage !== null) {
      const beyond = [...roll.tickets.values()].filter((t) => t.line > next.linesPerPage);
      if (beyond.length > 0) {
        throw new BusinessError(
          'INVALID_LINE_COUNT',
          `已有行号超出每页行数 ${next.linesPerPage}，不能缩小登记`,
          { linesPerPage: next.linesPerPage },
        );
      }
    }
    roll.pageCount = next.pageCount;
    roll.linesPerPage = next.linesPerPage;
    roll.lastPageLost = next.lastPageLost;
    roll.note = next.note;
    this.recompute(roll);
    return roll;
  }

  #assertOpen(roll) {
    if (roll.delivery?.finalized) {
      throw new BusinessError('ROLL_CLOSED', `票卷 ${roll.rollNo} 已完成清算交接，不能再导入`, {
        rollNo: roll.rollNo,
        handoffId: roll.delivery.handoffId,
      });
    }
  }

  #assertPageInRange(roll, page) {
    if (roll.pageCount !== null && page > roll.pageCount) {
      throw new BusinessError(
        'PAGE_OUT_OF_RANGE',
        `页码 ${page} 超出登记页数 ${roll.pageCount}，请核对是否拿错了卷`,
        { rollNo: roll.rollNo, page, pageCount: roll.pageCount },
      );
    }
  }

  #assertLineInRange(roll, line) {
    if (roll.linesPerPage !== null && line > roll.linesPerPage) {
      throw new BusinessError(
        'LINE_OUT_OF_RANGE',
        `行号 ${line} 超出登记的每页行数 ${roll.linesPerPage}，请核对是否拿错了卷`,
        { rollNo: roll.rollNo, line, linesPerPage: roll.linesPerPage },
      );
    }
  }

  /** 扫票进程导入单页。重复复印只入库一次，同时累计重复次数。 */
  importTicket(rollNo, ticket) {
    const roll = this.getRoll(rollNo);
    this.#assertOpen(roll);
    this.#assertPageInRange(roll, ticket.page);
    this.#assertLineInRange(roll, ticket.line);
    const key = keyOf(ticket);
    if (roll.tickets.has(key)) {
      roll.duplicates.set(key, (roll.duplicates.get(key) ?? 1) + 1);
      roll.arrivals.push({ ...ticket, duplicate: true, at: new Date().toISOString() });
      this.recompute(roll);
      return { roll, duplicate: true };
    }
    roll.tickets.set(key, {
      page: ticket.page,
      line: ticket.line,
      importedAt: new Date().toISOString(),
    });
    roll.arrivals.push({ ...ticket, duplicate: false, at: new Date().toISOString() });
    this.recompute(roll);
    return { roll, duplicate: false };
  }

  /** 扫票进程批量导入。整批先校验，失败则一页也不写入。 */
  importBatch(rollNo, tickets) {
    const roll = this.getRoll(rollNo);
    this.#assertOpen(roll);
    if (!Array.isArray(tickets) || tickets.length === 0) {
      throw new BusinessError('EMPTY_BATCH', '导入清单为空，请至少提供一页');
    }
    const normalized = normalizeTickets(tickets);
    for (const t of normalized) {
      this.#assertPageInRange(roll, t.page);
      this.#assertLineInRange(roll, t.line);
    }

    let duplicates = 0;
    for (const t of normalized) {
      const key = keyOf(t);
      if (roll.tickets.has(key)) {
        roll.duplicates.set(key, (roll.duplicates.get(key) ?? 1) + 1);
        roll.arrivals.push({ ...t, duplicate: true, at: new Date().toISOString() });
        duplicates += 1;
      } else {
        roll.tickets.set(key, { ...t, importedAt: new Date().toISOString() });
        roll.arrivals.push({ ...t, duplicate: false, at: new Date().toISOString() });
      }
    }
    this.recompute(roll);
    return { roll, imported: normalized.length - duplicates, duplicates };
  }

  /** 重算完整范围、已确认前缀与尾部状态。每次导入/交付后调用。 */
  recompute(roll) {
    const tickets = [...roll.tickets.values()].sort(compareTicket);
    const pages = [...new Set(tickets.map((t) => t.page))].sort((a, b) => a - b);
    const byPage = new Map();
    for (const t of tickets) {
      if (!byPage.has(t.page)) byPage.set(t.page, []);
      byPage.get(t.page).push(t.line);
    }

    const pageInfo = new Map();
    for (const [page, lines] of byPage) {
      lines.sort((a, b) => a - b);
      const expected = roll.linesPerPage ?? lines[lines.length - 1];
      const gaps = [];
      for (let line = 1; line <= expected; line += 1) {
        if (!lines.includes(line)) gaps.push(line);
      }
      pageInfo.set(page, { page, lines, expected, gaps, full: gaps.length === 0 });
    }

    // 已确认前缀：第 1 页起连续且整页行号齐全。
    // 已知总页数且卷尾标记丢失时，尾页不算确认，避免把残缺尾页当完整。
    let confirmedEnd = 0;
    for (let page = 1; ; page += 1) {
      if (roll.pageCount !== null && page > roll.pageCount) break;
      if (roll.lastPageLost && roll.pageCount !== null && page >= roll.pageCount) break;
      const info = pageInfo.get(page);
      if (!info || !info.full) break;
      confirmedEnd = page;
    }

    const complete =
      roll.pageCount !== null &&
      !roll.lastPageLost &&
      pages.length === roll.pageCount &&
      pages.every((p, i) => p === i + 1) &&
      pages.every((p) => pageInfo.get(p).full);

    const segments = [];
    if (pages.length > 0) {
      let start = pages[0];
      let prev = start;
      const push = (from, to) => {
        const pageList = pages.filter((p) => p >= from && p <= to);
        const segTickets = tickets.filter((t) => t.page >= from && t.page <= to);
        const gaps = pageList.flatMap((p) => pageInfo.get(p).gaps.map((line) => ({ page: p, line })));
        segments.push({
          from,
          to,
          ticketCount: segTickets.length,
          pages: pageList,
          gaps,
          status: to <= confirmedEnd ? 'CONFIRMED' : 'AWAITING_MISSING',
          tail: `${segTickets[segTickets.length - 1].page}-${segTickets[segTickets.length - 1].line}`,
        });
      };
      for (const page of pages.slice(1)) {
        if (page === prev + 1) {
          prev = page;
          continue;
        }
        push(start, prev);
        start = page;
        prev = page;
      }
      push(start, prev);
    }

    let tailStatus;
    if (roll.lastPageLost) tailStatus = 'LOST';
    else if (roll.pageCount === null) tailStatus = 'UNREGISTERED';
    else if (complete) tailStatus = 'SEALED';
    else tailStatus = 'DAMAGED';

    const missingPages = [];
    const missingLines = [];
    if (roll.pageCount !== null) {
      const present = new Set(pages);
      for (let p = 1; p <= roll.pageCount; p += 1) {
        if (!present.has(p)) missingPages.push(p);
      }
    }
    for (const info of pageInfo.values()) {
      for (const line of info.gaps) missingLines.push({ page: info.page, line });
    }

    const duplicates = [...roll.duplicates.entries()]
      .map(([key, count]) => {
        const [page, line] = key.split(':').map(Number);
        return { page, line, count, extraCopies: count - 1 };
      })
      .sort(compareTicket);

    const sentTickets = new Set(roll.delivery ? roll.delivery.sentTickets : []);
    const sentPages = [...new Set([...sentTickets].map((k) => Number(k.split(':')[0])))].sort(
      (a, b) => a - b,
    );
    const sentSegments = pagesToRanges(sentPages);

    roll.analysis = {
      tickets,
      pages,
      pageInfo,
      segments,
      complete,
      pageCount: roll.pageCount,
      linesPerPage: roll.linesPerPage,
      lastPageLost: roll.lastPageLost,
      tailStatus,
      coverage: pages.length ? `${pages[0]}-${pages[pages.length - 1]}` : '0-0',
      confirmedRange: confirmedEnd >= 1 ? { from: 1, to: confirmedEnd } : null,
      missingPages,
      missingLines,
      duplicates,
      duplicateCount: duplicates.reduce((sum, d) => sum + d.extraCopies, 0),
      sentTickets,
      sentSegments,
    };
    return roll.analysis;
  }

  #incompleteReason(analysis) {
    if (analysis.pageCount === null) {
      return '未登记页码数，无法确认完整范围；请登记页码数，或选择“先交已确认段”';
    }
    if (analysis.lastPageLost) {
      return '卷尾页已标记丢失，完整范围不成立；请补交尾页，或选择“先交已确认段”';
    }
    if (analysis.missingPages.length > 0) {
      const shown = analysis.missingPages.slice(0, 10).join('、');
      const more = analysis.missingPages.length > 10 ? '…' : '';
      return `还缺 ${analysis.missingPages.length} 页（${shown}${more}），完整范围不成立；请补页或选择“先交已确认段”`;
    }
    return '仍有页缺行，完整范围不成立；请补交缺行或选择“先交已确认段”';
  }

  /**
   * 生成待交付计划，不落状态；commitDelivery 才会写交接单。
   * mode = complete：整卷交付，要求完整，否则拒绝。
   * mode = confirmed：只交卷首已确认段，可多次追加，只送新增票页。
   */
  planDelivery(rollNo, opts = {}) {
    const roll = this.getRoll(rollNo);
    const mode = opts.mode ?? 'complete';
    if (mode !== 'complete' && mode !== 'confirmed') {
      throw new BusinessError('INVALID_MODE', 'mode 只能是 complete 或 confirmed');
    }
    const analysis = this.recompute(roll);

    if (roll.delivery?.finalized) {
      throw new BusinessError('ALREADY_FINALIZED', `票卷 ${rollNo} 已完成清算交接，不能重复交付`, {
        rollNo,
        handoffId: roll.delivery.handoffId,
      });
    }
    if (analysis.tickets.length === 0) {
      throw new BusinessError('NOTHING_TO_DELIVER', '还没有导入任何票页', { rollNo });
    }
    if (mode === 'complete' && !analysis.complete) {
      throw new BusinessError('INCOMPLETE_ROLL', this.#incompleteReason(analysis), {
        rollNo,
        missingPages: analysis.missingPages,
        missingLines: analysis.missingLines.slice(0, 20),
        confirmedRange: analysis.confirmedRange,
      });
    }
    if (mode === 'confirmed' && !analysis.confirmedRange) {
      throw new BusinessError(
        'NO_CONFIRMED_SEGMENT',
        '卷首还不连续或首页缺行，没有可确认的段落；请先补齐靠前的页',
        { rollNo, firstSegment: analysis.segments[0] ?? null },
      );
    }

    const range = mode === 'complete'
      ? { from: 1, to: roll.pageCount }
      : analysis.confirmedRange;
    const requestedTickets = analysis.tickets.filter((t) => t.page >= range.from && t.page <= range.to);
    const newTickets = requestedTickets.filter((t) => !analysis.sentTickets.has(keyOf(t)));
    const repeatedTickets = requestedTickets.length - newTickets.length;

    if (mode === 'confirmed' && newTickets.length === 0) {
      throw new BusinessError('NO_NEW_CONTENT', '已确认段此前都已交付，没有新的票页可送', {
        rollNo,
        handoffId: roll.delivery?.handoffId ?? null,
        confirmedRange: analysis.confirmedRange,
        sentSegments: analysis.sentSegments,
      });
    }

    return {
      rollNo,
      mode,
      complete: mode === 'complete',
      range,
      coverage: `${range.from}-${range.to}`,
      newTickets,
      newPages: pagesToRanges(newTickets.map((t) => t.page)),
      repeatedTickets,
      analysis,
    };
  }

  /** 确认交付：只把未清算的票页写进交接单，已清算票页绝不重复送。 */
  commitDelivery(rollNo, opts = {}) {
    const roll = this.getRoll(rollNo);
    const plan = this.planDelivery(rollNo, opts);
    const a = plan.analysis;

    const handoff = {
      handoffId: this.idFactory(),
      rollNo,
      mode: plan.mode,
      complete: plan.complete,
      range: plan.range,
      coverage: plan.coverage,
      newTickets: plan.newTickets.length,
      newPages: plan.newPages,
      newTicketFingerprint: fingerprint(plan.newTickets),
      repeatedTicketsSuppressed: plan.repeatedTickets,
      fullFingerprint: fingerprint(a.tickets),
      confirmedRange: a.confirmedRange,
      tailStatus: a.tailStatus,
      missingPages: a.missingPages,
      createdAt: new Date().toISOString(),
      finalized: plan.complete,
      finalReason: plan.complete ? 'COMPLETE' : 'PARTIAL_CONFIRMED',
      note: plan.complete
        ? plan.newTickets.length > 0
          ? `整卷范围 ${plan.coverage} 已确认完整，本次交付新增页 ${formatRanges(plan.newPages) || '无'}`
          : `整卷范围 ${plan.coverage} 此前已分段交清，本次只做最终确认，未重复送票页`
        : `仅交付卷首已确认段 ${plan.coverage}，后续段留待补交`,
    };

    const sentTickets = new Set(roll.delivery ? roll.delivery.sentTickets : []);
    for (const t of plan.newTickets) sentTickets.add(keyOf(t));

    roll.delivery = {
      handoffId: handoff.handoffId,
      finalized: handoff.finalized,
      mode: handoff.mode,
      coverage: handoff.coverage,
      sentTickets,
      history: [...(roll.delivery?.history ?? []), handoff],
      createdAt: handoff.createdAt,
    };
    this.handoffs.set(handoff.handoffId, handoff);
    this.recompute(roll);
    return handoff;
  }

  /** 统一整卷视图，页面与 API 共用。 */
  view(rollNo) {
    const roll = this.getRoll(rollNo);
    const a = this.recompute(roll);
    const sentTickets = a.sentTickets;
    return {
      rollNo: roll.rollNo,
      pageCount: roll.pageCount,
      linesPerPage: roll.linesPerPage,
      lastPageLost: roll.lastPageLost,
      note: roll.note,
      importedTickets: a.tickets.length,
      importedPages: a.pages.length,
      arrivalOrder: roll.arrivals.map((t) => `${t.page}-${t.line}${t.duplicate ? '（复印）' : ''}`).slice(-40),
      duplicateCount: a.duplicateCount,
      duplicates: a.duplicates,
      pagesPresent: a.pages,
      missingPages: a.missingPages,
      missingLines: a.missingLines,
      complete: a.complete,
      coverage: a.coverage,
      confirmedRange: a.confirmedRange,
      tailStatus: a.tailStatus,
      segments: a.segments.map((s) => {
        const segTickets = a.tickets.filter((t) => t.page >= s.from && t.page <= s.to);
        const sentCount = segTickets.filter((t) => sentTickets.has(keyOf(t))).length;
        return {
          from: s.from,
          to: s.to,
          pages: s.pages,
          ticketCount: s.ticketCount,
          status: s.status,
          gapCount: s.gaps.length,
          gaps: s.gaps.slice(0, 8),
          tail: s.tail,
          sentTickets: sentCount,
          sent: sentCount === segTickets.length && segTickets.length > 0,
        };
      }),
      delivery: roll.delivery
        ? {
            handoffId: roll.delivery.handoffId,
            finalized: roll.delivery.finalized,
            mode: roll.delivery.mode,
            coverage: roll.delivery.coverage,
            sentPages: pagesToRanges([...sentTickets].map((k) => Number(k.split(':')[0]))),
            sentTickets: sentTickets.size,
            history: roll.delivery.history,
          }
        : null,
      handoff: roll.delivery ? roll.delivery.history[roll.delivery.history.length - 1] : null,
      finalized: Boolean(roll.delivery?.finalized),
      tickets: a.tickets,
    };
  }
}
