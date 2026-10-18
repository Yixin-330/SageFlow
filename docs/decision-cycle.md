# 阶段六：召回驱动的状态与决策闭环

仓库此前未给阶段六规定单独的范围。本阶段把阶段五的 Recall Bundle 接入已有确定性情境模拟：`createDecisionCycle({ memoryEngine }).evaluate(session)` 根据当前场景构造 Recall Request，取得有证据的记忆，再分别计算 Baseline、Memory、SageFlow。页面不再自己拼一个空情境召回请求；决策记录保留 `recall_trace_id` 与匹配服务规则 ID。

状态模型按记忆的 `statement.predicate` 读取预算和提醒偏好，而不依赖 `mem_budget_150` 等固定 ID。预算压力只有在本次召回确实包含预算记忆时才成立；当前观察仍优先于长期偏好。匹配的程序性记忆目前只允许在低紧迫情境触发 `remain_silent`，不能凭记忆自动购买、取消或绕过权限检查。

运行 `npm run evaluate:cycle`：它把 8 个旅行故事的事件送入 Memory Engine，再通过召回、状态、决策和拒绝反馈运行一次完整回放。另有两组反事实：移除预算记忆、加入情境匹配的静默服务规则，检查相同情境下的状态或行动是否按预期改变。该评测是模拟回归，尚非真实模型、真实用户或外部服务性能测试。
