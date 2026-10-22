# 记忆人工评测指南

人工评测用于判断语义是否忠于证据、是否值得保存，以及类型、范围和敏感性是否合理。它不替代协议和权限的自动门禁。现行评审队列为 [`evaluation/human-memory-review-v2.jsonl`](../evaluation/human-memory-review-v2.jsonl)，包含完整的候选记忆陈述、`scope`、`retention` 和 `sensitivity`；旧文件保留为原始人工反馈，不作为默认可运行队列。

## 标注字段

- `should_remember`: `yes` / `no` / `needs_confirmation`
- `memory_tier`: `short_term` / `long_term` / `none`
- `memory_domain`: `user` / `relational` / `shared` / `none`
- `memory_kind`: `episodic` / `semantic` / `procedural` / `none`
- `faithful_to_evidence`: `yes` / `partly` / `no`
- `scope_correct`: `yes` / `no`
- `sensitivity_correct`: `yes` / `no`
- `notes`: 给出分歧原因和更合适的标准记忆表达

`should_remember` 判断**原始证据**是否足以形成一条 Memory Item，而不是判断系统提出的候选是否正确。若只应更新即时 State 或记录一次 Decision / Action，选择 `no`，并在 `notes` 标明去向。`memory_tier`、`memory_domain`、`memory_kind` 表示评审认为正确的记忆分类；无记忆时均选 `none`。`faithful_to_evidence`、`scope_correct`、`sensitivity_correct` 则评价**系统提出的候选**，不得按评审自己改写后的句子打分。

`scope_correct` 同时检查时间、行程、对象和触发条件，不应把“今天”“本次旅行”“这个展览”扩成全局偏好。`sensitivity_correct` 按候选的 `sensitivity` 字段判断；健康信息即便只写成服务约束，也不能自动当作普通偏好。每条案例都需要查看完整源句与候选结构，不能凭候选文字猜测缺失字段。

## 流程

1. 两名评审独立编辑 [`evaluation/human-memory-review-v2.jsonl`](../evaluation/human-memory-review-v2.jsonl) 的副本；保留原队列不变。
2. 不向评审展示另一人的标签，避免锚定。
3. 汇总一致率；关键标签建议计算 Cohen's Kappa。
4. 分歧案例由第三人仲裁，并优先检查术语或标注说明是否模糊。
5. 将确认后的结果固化为新的自动回归案例。

真实用户数据进入评测前必须完成授权、最小化和去标识化。

## 可运行评测

`npm run evaluate:human` 在没有评审文件时仅报告待评审数量，所有一致率均为 `null`，不会把示例记忆当作人工金标。两位评审各自使用一个**合法 JSONL** 文件，每行包含 `review_id`、稳定的匿名 `reviewer` 标识以及完整的 `labels` 对象；字符串值必须用双引号，字段和取值见上表。运行：

```powershell
npm run evaluate:human -- reviewer-a.jsonl reviewer-b.jsonl
```

如需指定其他可解析队列：`npm run evaluate:human -- --queue path/to/queue.jsonl reviewer-a.jsonl reviewer-b.jsonl`。评审员不要直接改写候选字段，也不要把纠正后的记忆句子误当作系统输出。

脚本检查未知/重复 ID、标签取值和评审身份独立性，输出双人覆盖率、逐字段完全一致率及 Cohen's Kappa。存在分歧时状态仍为 `needs_review`，须另行仲裁；不要直接覆盖原始独立标注。只统计已配对案例，未标注案例不会进入分母伪装成一致。
