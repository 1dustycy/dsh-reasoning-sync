# ADR-0005：端点说 mandatory 时，同步会移除已声明的 `off`

## 状态

已采纳（2026-10-07）

## 背景

「不写 off」这条硬约束的**理由**写得很清楚（`CONTEXT.md` → 不写 off）：写了 `off` 键，适配器
在"未选等级"时会下发 `reasoning: { effort: "none" }`，而 mandatory 模型对 `none` 直接回
400 `"Reasoning is mandatory for this endpoint and cannot be disabled."`（实测见上游
`dsh-desktop-profile#1`）。

第一版实现把这条约束读成了"既不新增也不删除"：`declarationFor()` 会把已存在的 `off` 原样
搬进它写出的字典，mandatory 模型也不例外。于是出现了这样的路径：

1. 用户的模型条目上带着 `off: null`（可能是早先手工写的，也可能是别的工具留下的）；
2. 端点公布该模型 `mandatory: true`，并且加了一个新档位；
3. 同步写入新的等级声明——**连同那个 `off` 一起**；
4. 从此"未选等级"就下发 `none`，每次请求 400。

也就是说：插件没有"生成" `off`，却把一个已知会 400 的配置**确认并写回**了。user story 7
（"让端点公布为 mandatory 的模型永远不会被我写成可关闭"）说的正是这件事，而"绝不生成"只
覆盖了从零构造的那一半。

## 决定

**端点公布 `mandatory: true` 时，写入的等级声明里不带 `off`。**

- 端点**没有说** mandatory（`false` 或字段缺席）时，行为不变：已存在的 `off` 原样保留
  （`CONTEXT.md` 的"既不新增也不删除"仍然成立，而且那是用户的合法选择——比如给
  `off` 指定 `disabled` 这样的 wire 值）。
- 端点**说了** mandatory 时，`off` 被移除，判定带 `removed: ["off"]`，卡片与 agent 工具
  都会把这次移除说出来——静默的破坏性编辑正是本插件处处在躲的东西。

判据是端点公布的事实，不是我们猜的：`capability.mandatory === true` 才触发。

## 后果

- 一次同步可能删掉一个用户写过的键。这是有意的、有据可查的，而且**只删那一个**：
  其余键照旧，报告里点名。
- "不写 off"现在是三条规则合起来读：绝不新增、默认保留、mandatory 时移除。`CONTEXT.md`
  的不写 off 条目按这三条改写。
- 端点把 `mandatory` 从 true 改成 false 后，插件不会把 `off` 加回来（那仍然属于"新增"）。
  想恢复由用户自己写。
