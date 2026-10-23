# 阶段七：评测与可观测性加固

本阶段不接入真实模型。沿阶段 0–6 的原型路线，将已有确定性测试整理成可重复的质量门禁，并显式区分原型验证与真实试点准备。

## 实现范围

- 每个模拟场景的初始情境生成一条可追踪的 `context.initialized` Observation Event；状态证据不再指向无来源的占位字符串。
- `DecisionCycle` 返回证据审计：检查 Recall Trace、选中行动、召回记忆、状态证据和服务规则引用。审计只确认当前事件与本次召回记忆的引用；历史种子记忆的原始事件若未载入，会列为 `historical_memory_evidence_unverified`，不能算作来源已核验。
- [`evaluation/stress-cases.json`](../evaluation/stress-cases.json) 增加 8 条困难反事实，覆盖权限、信息过期、预算缺失、亲子状态、记忆冲突、用户自述和敏感记忆授权。
- `npm run evaluate:human` 读取两份独立人工标注，计算覆盖率、一致率与 Cohen's Kappa；无标注时保持 `needs_review`。
- `npm run evaluate:stage7` 汇总记忆、召回、晋升、闭环、困难场景及人工评审状态；晋升门禁失败会让 `prototype_pass` 失败。`prototype_pass` 只用于确定性模拟回归；`pilot_ready` 继续为否，直到真实数据库/服务、人工评审及真实用户效果完成验证。

## 当前边界

这个门禁没有调用外部旅行服务或真实模型，也没有测量线上 P95 时延。困难场景是人为编写的反事实，不代表真实流量分布。若要进入试点，下一步应补双人盲评、独立仲裁、真实 PostgreSQL 集成和服务降级演练，再制定试点级阈值。
