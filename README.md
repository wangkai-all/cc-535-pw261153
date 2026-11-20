# 票卷交接站

收票站的本地演示：扫票进程交付原页，拼卷进程确认完整范围，清算端按票页（页码 + 行号）记账。
零依赖，只用 Node.js 内置模块；数据在内存中，重启即清空。

## 启动

```bash
PORT=3000 node server.js
# 或
PORT=3000 npm start
```

服务只绑定 `127.0.0.1`，默认端口 3000（可用 `PORT` 覆盖）。打开 `http://127.0.0.1:<PORT>/`。

```bash
node --test          # 31 个用例，覆盖正常、异常与页面核对契约
npm test             # 同上
```

## 页面上的三个动作

| 按钮 | 作用 |
| --- | --- |
| 导入不完整票卷 | 把文本框里的票页打进当前卷，允许乱序、允许重复 |
| 补交中间页 | 把后补到的票页并入当前卷，自动重算完整范围 |
| 查看清算交接 | 读取当前卷最近一次交接单与全部历史 |

页面业务结果区带 `data-evidence-result` 属性，取值形如：

- `idle` — 尚未操作
- `IMPORT_PAGES:OK` / `SUPPLEMENT_PAGES:OK` — 导入或补交成功
- `DELIVER:OK` / `VIEW_HANDOFF:OK` — 交接成功
- `DELIVER:INCOMPLETE_ROLL` / `...:NO_CONFIRMED_SEGMENT` / `...:NO_NEW_CONTENT` /
  `...:ALREADY_FINALIZED` / `...:ROLL_CLOSED` — 被规则拒绝

「操作前 / 操作后」两栏是同一份卷状态摘要的前后快照，可直接逐行核对。

## 输入格式

每行一页，`页码-行号`（也接受 `页码,行号` 或空格分隔），例如：

```
1-1
1-2
4-2
```

同一 `(页码, 行号)` 重复出现只入库一次，页面上记为「重复复印」。

## 规则

1. **乱序到达**：先拿到尾页、再扫到前面的页都允许；导入时按票页排序去重。
2. **完整范围**：登记了页数（和可选的每页行数）时，要求第 1 页到末页连续、每页行号从 1 起无缺行。
   没登记每页行数时，以该页扫到的最大行号推断本页应有行数。
3. **两种交付口径**：
   - `complete` 只交完整卷；不完整一律拒绝（`409 INCOMPLETE_ROLL`）。
   - `confirmed` 只交卷首连续且行号齐全的已确认段，可多次追加。
4. **不重复送**：清算端按票页记账。已清算的票页即使后来补行再整卷交付，也不会重复送；
   交接单里用 `repeatedTicketsSuppressed` 记录被拦下的票页数。
5. **卷尾丢失**：`tailStatus = LOST`，整卷交付被拒，只能交已确认段。
   卷尾找回后用「卷级登记更正」取消丢失标记并补登记页数，完整范围立即重算。
6. **封存**：整卷交付后为最终交接（`finalized`），此后禁止再导入、再交付、再改登记。

`tailStatus` 取值：`SEALED`（完整）、`DAMAGED`（有缺口）、`LOST`（卷尾丢失）、`UNREGISTERED`（未登记页数）。

## 样例卷

| 卷号 | 场景 |
| --- | --- |
| `RM-2024-001` | 4 页登记，缺第 3 页，第 4 页缺第 3 行，第 1 页被复印两次 |
| `RM-2024-002` | 卷尾丢失，已扫 1、2 页，另有孤立第 4 页 |
| `RM-2024-003` | 2 页完整，可直接整卷交付 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/rolls` | 票卷列表（含完整视图） |
| POST | `/api/rolls` | 建卷 `{rollNo, pageCount?, linesPerPage?, lastPageLost?}` |
| PATCH | `/api/rolls/:rollNo` | 更正登记 `{pageCount?, linesPerPage?, lastPageLost?, note?}` |
| GET | `/api/rolls/:rollNo` | 单卷视图 |
| POST | `/api/rolls/:rollNo/pages` | 批量导入 `{tickets:[{page,line}]}` |
| PUT | `/api/rolls/:rollNo/pages/:page/lines/:line` | 单页导入 |
| POST | `/api/rolls/:rollNo/deliveries` | 交付 `{mode:"complete"\|"confirmed"}` |
| GET | `/api/rolls/:rollNo/handoff` | 最近交接单 |

错误统一为 `{ "error": { "code", "message", "details" } }`。

## 文件

```
server.js           HTTP 服务、路由、样例数据
lib/roll.mjs         票卷状态机：去重、完整范围、已确认段、交付记账
lib/ticket.mjs       页码/行号/卷号校验
lib/errors.mjs       业务错误与 HTTP 状态映射
public/index.html    页面
public/app.js        页面交互与前后核对
public/styles.css    样式
test/*.test.mjs      node --test 用例
```
