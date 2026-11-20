// 业务错误与 HTTP 状态映射。独立成模块，领域层不依赖 HTTP。
export class BusinessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.details = details;
  }
}

const STATUS_BY_CODE = Object.freeze({
  INVALID_ROLL_NO: 400,
  INVALID_PAGE: 400,
  INVALID_LINE: 400,
  INVALID_PAGE_COUNT: 400,
  INVALID_LINE_COUNT: 400,
  INVALID_FLAG: 400,
  INVALID_NOTE: 400,
  EMPTY_BATCH: 400,
  INVALID_MODE: 400,
  INVALID_TICKETS: 400,
  ROLL_NOT_FOUND: 404,
  ROLL_EXISTS: 409,
  ROLL_CLOSED: 409,
  ALREADY_FINALIZED: 409,
  INCOMPLETE_ROLL: 409,
  NO_CONFIRMED_SEGMENT: 409,
  NO_NEW_CONTENT: 409,
  NOTHING_TO_DELIVER: 409,
  PAGE_OUT_OF_RANGE: 422,
  LINE_OUT_OF_RANGE: 422,
});

export function httpStatusFor(code) {
  return STATUS_BY_CODE[code] ?? 400;
}
