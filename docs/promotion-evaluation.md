# 晋升第 5 步：评测门禁

运行 `npm run evaluate:promotion`。`evaluation/promotion-cases.json` 是显式金标的**模拟**场景集；`tests/promotion-evaluation.test.mjs` 保证门禁自身不会因错误期望或缺少高风险反例而误通过。当前包含 14 个场景、4 个应晋升、10 个不应晋升。通过只说明确定性原型满足这些样例，不代表真实模型或用户数据上的误晋升率为零。

## 自动指标

| 指标 | 分子 / 分母 | 用途 |
|---|---|
| 误晋升率 | 金标不应晋升却出现 `PROMOTE` 的场景 / 负例场景 | 按风险层级和谓词另行拆分；高风险门槛为 0 |
| 漏晋升率 | 金标应晋升却没有 `PROMOTE` 的场景 / 正例场景 | 避免保守策略掩盖服务损失 |
| Pending 过期率 | 已过期 Pending / 所有 Pending | 描述候选池去向，不作为单独通过条件 |
| 平均停留天数 | 已晋升或已过期组从首次证据到结束的天数均值 | 监控观察窗口 |
| 晋升后纠正/冲突率 | 晋升后被替代或发生冲突的场景 / 已晋升场景 | 描述后验风险；不直接等同误晋升 |
| 重复晋升与幂等违规 | 同组多次 `PROMOTE`，或 mutation 与持久化结果不一致 | 必须为 0 |
| 来源覆盖率 | 具备独立行程、事件 ID、来源边和幂等结果的晋升 / 所有晋升 | 必须为 100% |
| scope 准确率 | 晋升范围与模拟金标一致的场景 / 带 scope 金标的正例 | 必须为 100%；仍须人工复核语义合理性 |

分母为零时返回 `null`，不得解读为零错误。误晋升按风险和谓词报告样本量；测试门禁要求至少存在低风险与高风险负例、正例及 scope 金标。反例覆盖单次展览拒绝、一次行程预算收紧、同一行程重复、同一事件重复抽取、跨行程反证、混合行程类型、低置信 Pending、敏感健康信息、短期到期后第二段证据、现有长期记忆、显式全局声明、晋升后纠正、观察窗到期和事件重放。

## 人工评审

运行 `npm run evaluate:promotion -- --queue` 查看每个场景的事件、自动决定与目标 scope。至少两名评审分别判断：

1. `should_promote`：此时是否应形成长期记忆；对待确认场景，未经确认应填 `false`。
2. `scope_correct`：晋升后的范围是否被证据支持；未晋升时，系统保持原范围/不泛化是否正确。
3. `provenance_correct`：证据是否独立、来源是否足以解释决定；无晋升时，证据不足的解释是否正确。

两名评审各自写一条 JSONL 标注，合并到 `evaluation/promotion-human-review.jsonl`。格式示例（仅展示格式，**不是已完成标注**）：

```json
{"case_id":"two_leisure_trips","reviewer_id":"reviewer_a","should_promote":true,"scope_correct":true,"provenance_correct":true}
```

再次运行评测，报告会显示 `needs_review`、`needs_adjudication`、`review_findings` 或 `dual_review_complete`。评审意见不一致须仲裁；两人一致认为 scope 或来源有误也会阻断“人工完成”状态。不要把前期的记忆抽取人工标注复用为晋升标注。

## 上线边界

当前自动门禁只验证本地模拟数据。`pilot_ready` 始终为 `false`，直到人工 scope 评审、真实 PostgreSQL 并发/重试验证，以及真实用户结果测量另行完成。高影响谓词即使模拟误晋升为 0，也不能凭单个健康负例开放自动晋升。
