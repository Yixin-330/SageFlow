# 记忆人工评测指南

人工评测用于判断语义是否忠于证据、是否值得保存，以及类型、范围和敏感性是否合理。它不替代协议和权限的自动门禁。

## 标注字段

- `should_remember`: `yes` / `no` / `needs_confirmation`
- `memory_tier`: `short_term` / `long_term` / `none`
- `memory_domain`: `user` / `relational` / `shared` / `none`
- `memory_kind`: `episodic` / `semantic` / `procedural` / `none`
- `faithful_to_evidence`: `yes` / `partly` / `no`
- `scope_correct`: `yes` / `no`
- `sensitivity_correct`: `yes` / `no`
- `notes`: 给出分歧原因和更合适的标准记忆表达

## 流程

1. 两名评审独立编辑 [`evaluation/human-memory-review.jsonl`](../evaluation/human-memory-review.jsonl) 的副本。
2. 不向评审展示另一人的标签，避免锚定。
3. 汇总一致率；关键标签建议计算 Cohen's Kappa。
4. 分歧案例由第三人仲裁，并优先检查术语或标注说明是否模糊。
5. 将确认后的结果固化为新的自动回归案例。

真实用户数据进入评测前必须完成授权、最小化和去标识化。
