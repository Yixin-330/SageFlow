# SageFlow 用户智能原型

这个仓库包含一个可回放的“在途半日行程自适应”原型。当前已完成阶段 0–7：三模式决策基线、三维记忆协议、候选路由与暂存、可追溯的记忆关系、PostgreSQL 事务持久化、混合召回、召回驱动的状态/决策闭环，以及离线困难场景、证据审计与人工评测入口。

> 原型边界：当前默认使用确定性本地抽取器和模拟数据，不代表真实用户测试、真实模型能力或真实服务指标。JSON 模型与 PostgreSQL Adapter 已预留，但默认运行不连接外部系统。

## 启动

```powershell
npm start
```

打开 <http://localhost:4173/prototype/>。可以通过 `?variant=A`、`?variant=B`、`?variant=C` 切换三种结构差异明显的界面方案，底部浮动切换器也支持左右方向键。

## 验证

```powershell
npm test
```

单独运行第二阶段记忆专项评测：

```powershell
npm run evaluate:memory
npm run evaluate:recall
npm run evaluate:cycle
npm run evaluate:stress
npm run evaluate:human
npm run evaluate:stage7
npm run evaluate:promotion
```

`evaluate:stage7` 已包含晋升评测；晋升门禁失败时主原型门禁也会失败。未完成双人晋升 scope 评审仍显示为试点阻塞项。

PostgreSQL 配置、迁移和真实数据库集成测试见 [`docs/postgres-persistence.md`](docs/postgres-persistence.md)。
阶段五检索通道、召回协议及评测边界见 [`docs/hybrid-retrieval.md`](docs/hybrid-retrieval.md)。
阶段六闭环接入与反事实评测见 [`docs/decision-cycle.md`](docs/decision-cycle.md)。
阶段七原型门禁和人工评测边界见 [`docs/stage-seven-evaluation.md`](docs/stage-seven-evaluation.md)。
跨行程记忆晋升的第 5 步门禁与人工 scope 评审见 [`docs/promotion-evaluation.md`](docs/promotion-evaluation.md)。

测试包括：

- 核心协议字段、事件完整性和证据引用；
- 8 个旅行场景的状态、行动和静默断言；
- 8 个 Memory Engine 抽取、范围、反馈、冲突、纠正、隐私、召回和更新断言；
- 拒绝、忽略与纠正反馈不会错误覆盖长期偏好；
- 三模式能力边界。
- `flat` / `typed` / `hybrid` 三种内部记忆架构兼容；
- tier/domain/kind 分类、低置信暂存和状态隔离；
- `SUPPORTED_BY`、`CONTRADICTS`、`EXCEPTION_TO`、`SUPERSEDES`、`DERIVED_FROM` 关系；
- 记忆版本谱系和一对多拆分。
- PostgreSQL 事务提交/回滚、迁移校验和租户隔离。

## 主要目录

```text
CONTEXT.md              领域语言
docs/protocols/         协议说明
docs/evaluation.md      同期评测方法
schemas/                JSON Schema
scenarios/catalog.json  典型故事与模拟事件
src/engine.mjs          确定性状态与决策引擎
src/memory-engine/      observe/recall 记忆模块与 Adapter
evaluation/             自动评测集与人工评测模板
db/migrations/          PostgreSQL 记忆存储迁移
prototype/              可抛弃的 UI 原型
tests/                  协议与场景回归
```

## Memory Engine

产品模式只依赖两个方法：

```js
await memoryEngine.observe(events, { permissions });
await memoryEngine.recall(request);
```

本地原型使用 `createDeterministicExtractor` 和 `createInMemoryMemoryRepository`。Memory Engine 默认采用 `hybrid` 架构，也可传入 `architecture: "flat" | "typed" | "hybrid"` 回放基线。真实模型可通过 `createJsonModelExtractor({ invoke })` 接入；Node/PostgreSQL 运行时从 [`src/memory-engine/node-index.mjs`](src/memory-engine/node-index.mjs) 导入，迁移通过 `npm run migrate:postgres` 执行。
