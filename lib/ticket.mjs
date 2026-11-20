// 票页参数校验。纯函数，不依赖 I/O。
import { BusinessError } from './errors.mjs';

export const MAX_PAGE = 9999;
export const MAX_LINE = 9999;

/**
 * 卷号：1-32 位字母、数字、点、下划线、连字符，且以字母或数字开头。
 */
export function normalizeRollNo(value) {
  if (typeof value !== 'string') {
    throw new BusinessError('INVALID_ROLL_NO', '卷号必须是字符串');
  }
  const rollNo = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(rollNo)) {
    throw new BusinessError(
      'INVALID_ROLL_NO',
      '卷号需为 1-32 位字母、数字、点、下划线或连字符，且以字母或数字开头',
      { rollNo: value },
    );
  }
  return rollNo;
}

function parseBoundedInteger(value, { code, field, label, max }) {
  let n = value;
  if (typeof n === 'string' && /^\d+$/u.test(n.trim())) n = Number(n.trim());
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new BusinessError(code, `${label}需为 1-${max} 的整数`, { [field]: value });
  }
  return n;
}

/** 页码从 1 开始，最大 9999。 */
export function parsePage(value) {
  return parseBoundedInteger(value, { code: 'INVALID_PAGE', field: 'page', label: '页码', max: MAX_PAGE });
}

/** 行号从 1 开始，最大 9999。 */
export function parseLine(value) {
  return parseBoundedInteger(value, { code: 'INVALID_LINE', field: 'line', label: '行号', max: MAX_LINE });
}

/** 解析 /api/rolls/:rollNo/pages/:page/lines/:line 的路径参数。 */
export function parseTicketParams(params = {}) {
  return {
    rollNo: normalizeRollNo(params.rollNo ?? ''),
    page: parsePage(params.page),
    line: parseLine(params.line),
  };
}

function compareTicket(a, b) {
  return a.page - b.page || a.line - b.line;
}

/** 解析单个 {page, line}，返回数字化的新对象。 */
export function parseTicket(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new BusinessError('INVALID_TICKETS', '每一页需为 {page, line} 对象');
  }
  return { page: parsePage(raw.page), line: parseLine(raw.line) };
}

/**
 * 排序并去重。同页被复印两次时，同一 (页码, 行号) 只保留一条。
 * 接受任意顺序输入（先到尾页也允许），排序后返回阅读顺序。
 */
export function normalizeTickets(tickets) {
  if (!Array.isArray(tickets)) {
    throw new BusinessError('INVALID_TICKETS', '票页清单必须是数组');
  }
  const unique = new Map();
  for (const raw of tickets) {
    const t = parseTicket(raw);
    unique.set(`${t.page}:${t.line}`, t);
  }
  return [...unique.values()].sort(compareTicket);
}

export { compareTicket };
