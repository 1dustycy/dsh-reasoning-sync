# ADR-0002：非推理写成 `reasoningEfforts: false`，不是删掉这个字段

## 状态

已采纳（2026-10-07）

## 背景

端点明确公布某模型不带任何可声明的正向等级时，判定是 `clear`。`clear` 要落到配置上，而
`reasoningEfforts` 在该适配器里是一个联合类型：

```js
reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))])
```

可用的落点有三种，行为各不相同：

| 写法 | 适配器解析结果 | 未选等级时下发 |
| --- | --- | --- |
| `reasoningEfforts: false` | `reasoning: false` | 不发 `reasoning` 字段 |
| `reasoningEfforts: {}` | **报错**：`has an empty reasoningEfforts` | — |
| 删掉这个字段 | `reasoning: base?.reasoning ?? false`（继承内置目录） | 由内置目录决定 |

`{}` 直接被 `resolveModelReasoning()` 判为非法，所以"清空字典"不是一个可选项。剩下的是显式
`false` 与删字段。

删字段看起来更"干净"——把配置恢复成没写过。但它把一个**正面陈述**（"端点说这个模型不能
推理"）换成了一个**缺省**（"谁都没说话"）：`resolveModelReasoning` 的 `base?.reasoning`
会让内置目录里同 id 的条目重新决定能力。对 `openrouter-live` 这类自定义路由 `base` 是
`undefined`，两者恰好等价——但那是这条路由的巧合，不是规则。

## 决定

`clear` 写入 `reasoningEfforts: false`。

上游的验收标准也是这么写的（"非推理模型是 `false`"），而 `false` 是适配器唯一能表达
"这个模型不能推理"的合法值。

**前提：`reasoningEfforts` 字段本来就是本插件唯一会写的东西**（`CONTEXT.md` → 等级声明）。
所以 `clear` 对一个从没声明过等级的模型也会写 `false`：
端点明确公布了能力，配置就该如实反映它，而不是留一个会被内置目录填补的空缺。

## 后果

- 同步的每一种判定要么什么都不写，要么只动 `reasoningEfforts` 一个字段——`false` 与
  `{...}` 都是这个字段的取值。
- 与「不写 off」不冲突：`false` 与 `off` 是两种不同的东西，前者说"这个模型不能推理"，
  后者决定"未选等级时发什么"。插件永远不生成 `off` 键（`CONTEXT.md` → 不写 off）。
- 路由级默认等级（`providers.<route>.reasoning`）与本插件无关，插件不读也不写它。
