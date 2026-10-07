# ADR-0004：接受 settings 写入会丢掉该行 `config` 块里的注释

## 状态

已采纳（2026-10-07）

## 背景

handoff 把这条列为"本方案最大的未知"：设置界面与手工编辑共用 profile 的
`cordis.patch.yml`，一次同步写下去，那份手写文件会变成什么样？

用**安装包里真实的写入路径**离线复现过了：`lib/config-editor` 的写入是

```js
const document = parseDocument(before, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }] });
…
else document.setIn([index, "config"], document.createNode(next));
…
await writeFileAtomic(path, String(document), { mode: 384 });
```

（`dsh-config-editor/lib/index.js:91-123`。）

复现步骤（只读，不需要装应用之外的东西）：

1. 按 asar 头索引把 `dsh/node_modules/yaml/`（本次是 `yaml@2.9.1`）整棵解到一个临时目录；
2. `import { parseDocument, visit, isMap, isSeq, Scalar } from "<临时目录>/yaml/dist/index.js"`；
3. 对 profile 的 `cordis.patch.yml` **副本**依次执行上面四步（`parseDocument` → 找到
   `id: llm-pi-ai` 的行 → `document.setIn([index, "config"], document.createNode(next))` →
   `String(document)`）；
4. 把 `next` 构造成"给 `openai/gpt-6.1-sol` 加 `minimal`、去掉 `xhigh`"后与原文件 `diff`。

结果：

- **只有被替换那一行的 `config` 子树变了**，其他一切逐字节相同——文件头的注释、
  其他行、键顺序、缩进、引号风格都原样保留。`parseDocument` 是保注释的文档模型，
  改变的是 `setIn` 的目标范围。
- **那一行 `config` 块内部的注释全部消失。** 用户现在在 `openrouter-live:` 下写了
  12 行解释（为什么绝不写 `off`、刷新脚本怎么用），这 12 行在第一次同步后就不在了。
- 写入的字段本身精确落位：`reasoningEfforts` 的键按我们构造的顺序排列。

也就是说，这不是本插件"改文件"造成的，而是 settings 服务本身的写入粒度：它按 profile
entry 寻址、按 revision 校验、然后把**整个 `config` 节点**换成新值。任何走这条服务的
插件都一样。

## 决定

接受这个粒度，并把后果写进 README，而不是绕开它。

理由：

- settings 服务是唯一能同时给出 **revision 冲突保护** 和 **profile 层写入** 的路径。
  绕开它就只能自己改写文件，那等于把 revision 冲突（user story 16）和"设置界面与插件
  互相覆盖"重新引入，代价远大于注释。
- 丢失范围是**可解释、可预期**的：只有本插件真正同步过的那一行、只有它 `config` 块内部
  的注释。文件其他部分不动。
- 注释可以放在插件不写的地方：行的上方、文件头、仓库文档。README 明确这么说。

## 后果

- README 必须给出这条警告与安置建议，中英两半都要有。
- 用户在 `openrouter-live` 下那段"绝不写 off"的说明会消失，所以 `CONTEXT.md` 与
  ADR-0002 要承担那套理由的长期去处（它们已经在承担）。
- 这条只影响注释，不影响任何配置值：同步写出的字段是经过 revision 校验的。
