# ADR-0003：卡片走 Connection 的 Fetch 路由，不走 session command

## 状态

已采纳（2026-10-07）

## 背景

官方的插件开发技能（随应用分发的 `cordis-plugin-development`）在
`references/user-actions.md` 里给「一个操作、两个调用者」指定的客户端通路是：

> The UI action calls it through a Client-callable Host entry point found with
> inspection, such as a session command that `ctx.remote.commands.execute()` runs,
> and shows the returned failure.

那条路在安装包里确实存在，形状也读得到：

- Host 侧 `ctx.commands.register({ definitionId?, name, description, input?, recordInput?, handler })`
  （`dsh-commands/lib/index.js:266`），handler 收到一个冻结的
  `{ commandId, agent, rawInput, attachments, signal }`；
- Client 侧 `await ctx.remote.commands.execute(agentId, line, attachments)`
  （真实调用点 `dsh-api-session-controller/lib/client.js:1849`），返回
  `{ ok: true, value } | { ok: false, error }`；
- 它的 typert descriptor 标着 `scope: { context: "agent", wire: "agentId" }`
  （`dsh-api-remotes/lib/client.js:4882` 起）。

放到本插件上，三个事实让这条路不合适：

1. **卡片没有 agent。** 它挂在「设置 → 模型」页的 provider 卡片里，不属于任何会话。
   一次「同步配置」要去 `execute(agentId, ...)`，就得先决定"用哪个会话"——而那个决定
   与操作本身毫无关系。
2. **命令会写进会话日志。** 被承认的那次执行以 `command/done` 落在接收 agent 的会话里。
   用户点一下按钮，代价是一条他自己没要求的会话记录；而 user story 20 要的恰恰是
   「卸载或收起后界面干净，没有残留」。
3. **agent 作用域怎么绑，读不出来。** `dsh-api-remotes/lib/client.js` 里没有作用域解析
   代码，dispatcher 在 typert protocol 内部；本次调查把它标为 UNVERIFIED。把插件的
   主通路押在一个读不出实现的绑定上，不符合"先做能验证的部分"。

同一条技能也说明了这条路是**举例**（"such as"），不是唯一入口；而 Connection 的
Fetch 注册表是应用自己公开的另一条入口，安装包里已有四个调用方
（`dsh-client-ui-deliverables`、`dsh-session-log-export`、`dsh-client-file-upload`、
`dsh-api-session-controller`）。

## 决定

Host 向 `ctx.connection.fetch` 注册两条**精确路由**：

```
POST /api/reasoning-sync.sync      body { provider, action } → 操作结果
GET  /api/reasoning-sync.routes    → { namespaces, routes }
```

Client 用普通 `fetch` 调它们。两条路由都落在 Connection 的 `/api` 围栏内：请求经过同一套
Host/Origin 检查与浏览器会话 Cookie，插件不新开通道。

关键事实：这条通道在**两种载体**下都通。

- 浏览器（`dsh web`）：`dsh-client-connection` 在 `webServer` 存在时把
  `createSharedFetchHandler("/api")` 挂成 `/api` 前缀路由（`dsh-client-connection/lib/index.js:829`）；
- Desktop（Electron）：渲染进程跑在 `dsh-app://app` 下，`lib/main.js` 的协议处理器把
  **每一个路径**原样转发给内嵌 Host（`forwardWebRequest`，`lib/main.js:7461` 起：
  保留 method 与 body，换上 Host 自己的会话 Cookie），所以同一个路由表照样命中。

## 后果

- **一个操作，两个调用者**成立：tool 与卡片都调 `lib/sync.js` 的同一个 `run()`，
  两次调用的结果在 `test/apply.test.mjs` 里被断言为逐字段相同。
- 这条路由是**写入口**：它落在 Connection 的 `/api` 围栏内（Host/Origin 检查 + 浏览器会话
  Cookie），并且**不声明 action 时只读**——`run()` 的默认是 `preview`，写入必须由调用方
  明说 `apply`。这样即使有人直接 POST 一个空体，也不会改配置。
- 按钮不产生会话记录，不需要 agent，也不依赖任何"当前会话"的概念。
- 代价：这条路不是技能示例里点名的那条，所以 `test/registration.test.mjs` 把它的
  契约对着安装包钉住——路由路径必须过 shipped 的 endpoint 段语法，且
  `createSharedFetchHandler(API_PATH)` 仍在（改名或搬家会立刻失败）。
- 若将来官方把 session command 的作用域绑定写清楚、且出现"卡片属于某个会话"的真实需求，
  可以再加一条 command 通路；届时两条通路仍应共用 `run()`。
