// PROTOTYPE — three UI variants of the same Scenario Lab, switchable via ?variant=A|B|C.
import {
  MODES,
  createSession,
  advanceSession,
  runToEnd,
  evaluateModes,
  applyFeedback
} from "/src/engine.mjs";
import {
  createMemoryEngine,
  createInMemoryMemoryRepository,
  createDeterministicExtractor
} from "/src/memory-engine/index.mjs";
import { runMemoryEvaluation } from "/src/memory-engine/evaluation.mjs";
import { createDecisionCycle } from "/src/decision-cycle.mjs";
import { runDecisionCycleEvaluation } from "/src/decision-cycle-evaluation.mjs";

const [catalog, memoryEvaluationSuite, humanReviewText] = await Promise.all([
  fetch("/scenarios/catalog.json").then((response) => response.json()),
  fetch("/evaluation/memory-cases.json").then((response) => response.json()),
  fetch("/evaluation/human-memory-review.jsonl").then((response) => response.text())
]);
const memoryEvaluationReport = await runMemoryEvaluation(memoryEvaluationSuite, catalog.memory_catalog);
const cycleEvaluationReport = await runDecisionCycleEvaluation(catalog);
const humanReviewCases = humanReviewText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const ui = {
  scenarioId: catalog.scenarios[0].id,
  session: null,
  focusMode: "sageflow",
  variant: new URLSearchParams(location.search).get("variant")?.toUpperCase() || "A",
  eventNotice: "已载入初始情境，等待注入事件。",
  memoryEngine: null,
  decisionCycle: null,
  cycleResult: null,
  memoryTrace: { update: null, recall: null }
};

const variantNames = {
  A: "决策驾驶舱",
  B: "旅行故事视角",
  C: "对照评测矩阵"
};

function scenario() {
  return catalog.scenarios.find((item) => item.id === ui.scenarioId);
}

function resetSession() {
  ui.session = createSession(scenario(), catalog);
  ui.eventNotice = "已回到场景起点。";
}

resetSession();

async function initializeMemoryRuntime() {
  const repository = createInMemoryMemoryRepository(ui.session.memories);
  ui.memoryEngine = createMemoryEngine({
    repository,
    extractor: createDeterministicExtractor(),
    clock: { now: () => `2026-08-25T${ui.session.context.time}:00+08:00` }
  });
  ui.decisionCycle = createDecisionCycle({ memoryEngine: ui.memoryEngine });
  ui.cycleResult = null;
  ui.memoryTrace = { update: null, recall: null };
  await refreshMemoryRecall();
}

async function refreshMemoryRecall() {
  ui.cycleResult = await ui.decisionCycle.evaluate(ui.session);
  ui.memoryTrace.recall = ui.cycleResult.recall;
  ui.session.memories = ui.cycleResult.recall.memories.map((item) => item.memory);
}

async function observeMemory(events) {
  if (!events.length) return;
  ui.memoryTrace.update = await ui.memoryEngine.observe(events, { permissions: [] });
  await refreshMemoryRecall();
}

await initializeMemoryRuntime();

const esc = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const pct = (value) => `${Math.round(value * 100)}%`;
const labelForAction = (type) => ({
  generic_weather_alert: "天气提醒",
  generic_context_reply: "情境回复",
  recommend_indoor_photography: "兴趣推荐",
  personalized_context_reply: "个性化回复",
  recommend_family_stop: "亲子推荐",
  propose_itinerary_adjustment: "提议调整",
  remain_silent: "保持静默",
  ask_user_preference: "询问确认",
  suggest_nearby_rest: "建议就近休息",
  ask_permission: "请求授权"
}[type] || type);

function modeResults() {
  return ui.cycleResult?.modes ?? evaluateModes(ui.session);
}

function scenarioOptions() {
  return catalog.scenarios.map((item) => `<option value="${item.id}" ${item.id === ui.scenarioId ? "selected" : ""}>${item.id} · ${esc(item.title)}</option>`).join("");
}

function appHeader(section = "情境模拟器") {
  const sections = ["情境模拟器", "Traveler App", "评测"];
  return `
    <header class="app-header">
      <a class="brand" href="/prototype/" aria-label="SageFlow 首页">
        <span class="brand-mark">S</span>
        <span><b>SageFlow</b><small>长期关系智能原型</small></span>
      </a>
      <nav class="header-nav" aria-label="原型区域">
        ${sections.map((item) => `<span class="${item === section ? "nav-active" : ""}">${item}</span>`).join("")}
      </nav>
      <span class="prototype-badge"><i></i> PROTOTYPE · 模拟数据</span>
    </header>`;
}

function scenarioPicker() {
  const s = scenario();
  return `
    <section class="panel scenario-panel">
      <div class="eyebrow">SCENARIO</div>
      <label class="select-label" for="scenario-select">典型用户故事</label>
      <select id="scenario-select">${scenarioOptions()}</select>
      <p class="scenario-summary">${esc(s.summary)}</p>
      <div class="traveler-mini">
        <span class="avatar">${esc(s.traveler.name.slice(0, 1))}</span>
        <div><b>${esc(s.traveler.name)}</b><small>${esc(s.traveler.trip)} · ${esc(s.traveler.companions)}</small></div>
      </div>
    </section>`;
}

function contextGrid() {
  const c = ui.session.context;
  const items = [
    ["时间", c.time], ["位置", c.location], ["天气", c.weather], ["步数", `${Number(c.steps).toLocaleString()} 步`],
    ["下一安排", c.nextPlan], ["提醒历史", `${c.recentIgnored} 次忽略`]
  ];
  return `<div class="context-grid">${items.map(([key, value]) => `<div><span>${key}</span><b>${esc(value)}</b></div>`).join("")}</div>`;
}

function eventControls() {
  const s = scenario();
  const next = s.timeline[ui.session.cursor];
  const completed = ui.session.cursor >= s.timeline.length;
  return `
    <section class="panel event-control">
      <div class="panel-heading"><span><i class="pulse"></i>情境控制</span><small>${ui.session.cursor}/${s.timeline.length}</small></div>
      ${contextGrid()}
      <div class="next-event ${completed ? "complete" : ""}">
        <span>${completed ? "事件流已完成" : "下一事件"}</span>
        <b>${completed ? "可以注入反馈或重置回放" : esc(next.payload.description)}</b>
      </div>
      <div class="button-row">
        <button class="primary" data-action="advance" ${completed ? "disabled" : ""}>注入下一事件 <span>→</span></button>
        <button data-action="run-all" ${completed ? "disabled" : ""}>运行全部</button>
        <button class="icon-button" data-action="reset" title="重置">↺</button>
      </div>
      <p class="event-notice">${esc(ui.eventNotice)}</p>
    </section>`;
}

function eventTimeline(compact = false) {
  const s = scenario();
  const initial = `<li class="done"><span class="timeline-dot"></span><time>${esc(s.initial.time)}</time><div><b>载入旅行情境</b><small>${esc(s.initial.location)} · ${esc(s.initial.weather)}</small></div></li>`;
  const events = s.timeline.map((event, index) => {
    const done = index < ui.session.cursor;
    const active = index === ui.session.cursor;
    const time = event.occurred_at.slice(11, 16);
    return `<li class="${done ? "done" : active ? "active" : ""}"><span class="timeline-dot"></span><time>${time}</time><div><b>${esc(event.payload.description)}</b>${compact ? "" : `<small>${esc(event.event_type)}</small>`}</div></li>`;
  }).join("");
  return `<ol class="timeline">${initial}${events}</ol>`;
}

function modeCard(mode, result, expanded = false) {
  const action = result.selected_action;
  const isSilent = action.action_type === "remain_silent";
  return `
    <article class="mode-card mode-${mode} ${ui.focusMode === mode ? "focused" : ""}" data-mode="${mode}">
      <div class="mode-head">
        <div><span class="mode-index">${mode === "baseline" ? "01" : mode === "memory" ? "02" : "03"}</span><b>${MODES[mode].label}</b></div>
        <span class="mode-cap">${MODES[mode].short}</span>
      </div>
      <p class="mode-description">${MODES[mode].capability}</p>
      <div class="action-label ${isSilent ? "silent" : ""}"><i></i>${labelForAction(action.action_type)}</div>
      <blockquote>${esc(action.message)}</blockquote>
      <div class="reason-row"><span>理由</span><p>${esc(result.decision.decision_reason)}</p></div>
      ${expanded ? `
        <div class="score-strip">
          <span>价值 <b>${pct(action.expected_user_value)}</b></span>
          <span>打扰 <b>${pct(action.interruption_cost)}</b></span>
          <span>风险 <b>${pct(action.risk)}</b></span>
          <span>净分 <b>${result.decision.selected_score.toFixed(2)}</b></span>
        </div>` : ""}
      <button class="text-button" data-focus-mode="${mode}">查看决策证据 <span>↗</span></button>
    </article>`;
}

function stateInspector(result) {
  if (!result.state) {
    return `<div class="empty-state"><span>○</span><p>${MODES[result.mode].label} 不生成动态状态。</p></div>`;
  }
  const dimensions = Object.entries(result.state.dimensions);
  return `
    <div class="state-list">
      ${dimensions.map(([key, item]) => `
        <div class="state-row">
          <span>${({fatigue:"疲劳",time_pressure:"时间压力",interruption_tolerance:"打扰容忍",exploration_intent:"探索意愿",companion_need:"同行需求",budget_pressure:"预算压力",preference_conflict:"偏好冲突",data_freshness:"数据新鲜度"}[key] || key)}</span>
          <b class="state-value value-${item.value}">${item.value}</b>
          <em>${pct(item.confidence)}</em>
          <small>${item.evidence_ids.map(esc).join(" · ")}</small>
        </div>`).join("")}
    </div>`;
}

function memoryInspector(result) {
  if (!result.recalled_memories.length) return `<div class="empty-state"><span>○</span><p>该模式不读取长期记忆。</p></div>`;
  return `<div class="memory-list">${result.recalled_memories.map((memory) => `
    <div class="memory-item">
      <div><span>${memory.memory_tier === "short_term" || memory.memory_type === "short_term" ? "短期" : memory.memory_domain === "relational" || memory.memory_type === "relationship" ? "关系" : "长期"}</span><b>${pct(memory.confidence)}</b></div>
      <p>${esc(memory.label ?? `${memory.statement.predicate}: ${memory.statement.value}`)}</p>
      <small>${memory.memory_id}</small>
    </div>`).join("")}</div>`;
}

function memoryPipelineInspector() {
  const update = ui.memoryTrace.update;
  const recall = ui.memoryTrace.recall;
  const candidateCount = update?.candidates?.length ?? 0;
  const mutationCount = update?.mutations?.length ?? 0;
  const rejectedCount = update?.rejections?.length ?? 0;
  const pendingCount = update?.pending_candidates?.length ?? 0;
  return `
    <div class="memory-pipeline">
      <div><span>候选</span><b>${candidateCount}</b></div>
      <div><span>变更</span><b>${mutationCount}</b></div>
      <div><span>冲突</span><b>${recall?.conflicts?.length ?? 0}</b></div>
      <div><span>关系</span><b>${recall?.relations?.length ?? 0}</b></div>
      <div><span>必须证据</span><b>${recall?.mandatory_evidence?.length ?? 0}</b></div>
      <div><span>服务规则</span><b>${recall?.matched_rules?.length ?? 0}</b></div>
      <div><span>待确认</span><b>${pendingCount}</b></div>
      <div><span>排除</span><b>${(recall?.omitted?.length ?? 0) + rejectedCount}</b></div>
    </div>
    ${update?.mutations?.length ? `<div class="mutation-trace">${update.mutations.map((item) => `<span><b>${item.operation}</b>${esc(item.reason_code ?? item.coexistence_reason ?? item.target_memory_id ?? "已记录")}</span>`).join("")}</div>` : `<p class="pipeline-empty">尚未产生新的 Memory Mutation；当前显示初始记忆召回。</p>`}
    ${recall?.memories?.length ? `<div class="recall-scores">${recall.memories.slice(0, 4).map((item) => `<span><b>${item.score.toFixed(2)}</b>${esc(item.memory.label ?? item.memory.statement.predicate)}</span>`).join("")}</div>` : ""}`;
}

function traceInspector(result) {
  return `
    <section class="panel trace-panel">
      <div class="panel-heading"><span>决策透视</span><div class="segmented">${Object.keys(MODES).map((mode) => `<button data-focus-mode="${mode}" class="${mode === ui.focusMode ? "active" : ""}">${MODES[mode].label}</button>`).join("")}</div></div>
      <div class="trace-tabs"><span>Memory</span><span>State</span><span>Decision</span></div>
      ${result.mode === "baseline" ? "" : `<div class="trace-section"><h3>Memory Engine 轨迹 <small>observe → recall</small></h3>${memoryPipelineInspector()}</div>`}
      <div class="trace-section"><h3>召回记忆 <small>${result.recalled_memories.length}</small></h3>${memoryInspector(result)}</div>
      <div class="trace-section"><h3>当前状态 <small>${result.state ? Object.keys(result.state.dimensions).length : 0}</small></h3>${stateInspector(result)}</div>
      <div class="trace-section decision-detail">
        <h3>最终选择</h3>
        <b>${labelForAction(result.selected_action.action_type)}</b>
        <p>${esc(result.decision.decision_reason)}</p>
        <small>${result.selected_action.reason_codes.join(" · ")}</small>
        ${result.decision.recall_trace_id ? `<small>Recall Trace: ${esc(result.decision.recall_trace_id)}</small>` : ""}
      </div>
    </section>`;
}

function feedbackBar(result) {
  return `
    <section class="feedback-bar">
      <div><span>模拟真实反馈</span><b>反馈只记录结果，不直接假设原因</b></div>
      <div class="feedback-actions">
        <button data-feedback="action_accepted">✓ 接受</button>
        <button data-feedback="action_rejected">× 拒绝</button>
        <button data-feedback="action_ignored">— 忽略</button>
        <button data-feedback="user_corrected">✎ 纠正：今天想多走走</button>
      </div>
      <div class="mutation-result">${ui.session.mutations.at(-1) ? `<span>${ui.session.mutations.at(-1).operation}</span>${esc(ui.session.mutations.at(-1).reason)}` : "尚未注入反馈"}</div>
    </section>`;
}

function evaluationPanel(compact = false) {
  const report = cycleEvaluationReport;
  const labels = { protocol: "数据协议", memory: "记忆召回", state: "状态模型", decision: "主动决策", trace: "证据追踪", feedback: "反馈闭环" };
  return `
    <section class="panel evaluation-panel ${compact ? "compact" : ""}">
      <div class="panel-heading">
        <span>同步评测 <small>确定性模拟回归</small></span>
        <b class="pass-total"><i></i>${report.passed}/${report.total} 场景通过</b>
      </div>
      <div class="metric-row">${Object.entries(report.modules).map(([key, metric]) => `
        <div class="metric"><span>${labels[key]}</span><b>${metric.passed}/${metric.total}</b><div><i style="width:${pct(metric.rate)}"></i></div></div>`).join("")}</div>
      ${compact ? "" : `<p class="eval-disclaimer">这些结果验证协议与金标断言是否一致，不代表真实模型准确率或真实用户效果。</p>`}
    </section>`;
}

function memoryEvaluationPanel(compact = false) {
  const reviewed = humanReviewCases.filter((item) => item.status === "reviewed").length;
  const categoryLabels = { extraction: "抽取", scope: "范围", feedback: "反馈", conflict: "冲突", correction: "纠正", privacy: "隐私", recall: "召回", update: "更新" };
  return `
    <section class="panel memory-evaluation-panel ${compact ? "compact" : ""}">
      <div class="panel-heading"><span>第二阶段 · Memory Engine <small>接口行为回归</small></span><b class="pass-total"><i></i>${memoryEvaluationReport.passed}/${memoryEvaluationReport.total} 通过</b></div>
      <div class="memory-eval-categories">${Object.entries(memoryEvaluationReport.categories).map(([key, item]) => `<span><small>${categoryLabels[key] ?? key}</small><b>${item.passed}/${item.total}</b></span>`).join("")}</div>
      <div class="human-review-status"><span>人工语义评测</span><b>${reviewed}/${humanReviewCases.length} 已复核</b><small>${humanReviewCases.length - reviewed} 条待双人独立标注；自动通过不替代人工金标。</small></div>
    </section>`;
}

function variantA() {
  const results = modeResults();
  return `
    ${appHeader("情境模拟器")}
    <main class="variant-a page-shell">
      <div class="page-title"><div><span class="eyebrow">SCENARIO LAB · VARIANT A</span><h1>让同一段旅程，跑出三种智能差异</h1><p>控制事件，观察记忆、状态与主动决策如何改变下一步。</p></div><div class="run-status"><i></i><span>虚拟时钟</span><b>${ui.session.context.time}</b></div></div>
      <div class="cockpit-grid">
        <aside>${scenarioPicker()}${eventControls()}<section class="panel timeline-panel"><div class="panel-heading"><span>事件时间线</span></div>${eventTimeline(true)}</section></aside>
        <section class="comparison-stage">
          <div class="section-label"><span>MODE COMPARISON</span><small>相同输入 · 不同能力边界</small></div>
          <div class="mode-grid">${Object.entries(results).map(([mode, result]) => modeCard(mode, result)).join("")}</div>
          ${feedbackBar(results.sageflow)}
          ${evaluationPanel()}
          ${memoryEvaluationPanel(true)}
        </section>
        <aside>${traceInspector(results[ui.focusMode])}</aside>
      </div>
    </main>
    ${variantSwitcher()}`;
}

function travelerPhone(result) {
  const c = ui.session.context;
  return `
    <div class="phone-frame">
      <div class="phone-status"><span>${c.time}</span><span>● ●● ︎▰</span></div>
      <div class="phone-header"><button>⌄</button><div><b>${scenario().traveler.trip}</b><small>${c.location} · ${c.weather}</small></div><span class="sage-orb">S</span></div>
      <div class="trip-glance">
        <span>下一安排</span><b>${esc(c.nextPlan)}</b><small>约 ${c.distanceMinutes} 分钟 · ${Number(c.steps).toLocaleString()} 步</small>
      </div>
      <div class="conversation">
        <div class="day-divider">SageFlow 正在陪伴这段旅程</div>
        <div class="assistant-message ${result.selected_action.action_type === "remain_silent" ? "silent-message" : ""}">
          <span class="mini-orb">S</span>
          <div><small>${result.selected_action.action_type === "remain_silent" ? "此刻选择不打扰" : "SageFlow · 主动建议"}</small><p>${esc(result.selected_action.message)}</p>
            ${result.selected_action.requires_confirmation ? `<div class="message-actions"><button data-feedback="action_accepted">接受调整</button><button data-feedback="action_rejected">保留原计划</button></div>` : ""}
            <button class="why-button" data-focus-mode="sageflow">为什么这样建议？</button>
          </div>
        </div>
      </div>
      <div class="composer"><span>＋</span><p>告诉 SageFlow 你的想法…</p><button>↑</button></div>
    </div>`;
}

function variantB() {
  const results = modeResults();
  return `
    ${appHeader("Traveler App")}
    <main class="variant-b page-shell">
      <div class="story-heading"><span class="eyebrow">STORY VIEW · VARIANT B</span><h1>先看见用户，再看见系统</h1><p>以真实旅行体验为中心，调试信息退居故事两侧。</p></div>
      <div class="story-layout">
        <aside class="story-timeline panel">
          ${scenarioPicker()}
          <div class="panel-heading"><span>旅程正在发生</span><small>${ui.session.cursor}/${scenario().timeline.length}</small></div>
          ${eventTimeline()}
          <div class="story-controls">${eventControls()}</div>
        </aside>
        <section class="traveler-stage">
          <span class="stage-label">用户实际看到的页面</span>
          ${travelerPhone(results.sageflow)}
          ${feedbackBar(results.sageflow)}
        </section>
        <aside class="why-rail">
          <section class="panel insight-card"><span class="eyebrow">WHY NOW</span><h2>${labelForAction(results.sageflow.selected_action.action_type)}</h2><p>${esc(results.sageflow.decision.decision_reason)}</p><div class="reason-codes">${results.sageflow.selected_action.reason_codes.map((code) => `<span>${code}</span>`).join("")}</div></section>
          <section class="panel"><div class="panel-heading"><span>被召回的理解</span></div>${memoryInspector(results.sageflow)}</section>
          <section class="panel"><div class="panel-heading"><span>此刻状态</span></div>${stateInspector(results.sageflow)}</section>
        </aside>
      </div>
      <section class="mode-strip"><div><span>同一情境的对照结果</span><small>点击查看证据</small></div>${Object.entries(results).map(([mode, result]) => `<button data-focus-mode="${mode}"><b>${MODES[mode].label}</b><span>${labelForAction(result.selected_action.action_type)}</span><small>${esc(result.selected_action.message)}</small></button>`).join("")}</section>
      ${evaluationPanel(true)}
    </main>
    ${variantSwitcher()}`;
}

function comparisonTable(results) {
  const rows = [
    ["可见信息", "当前事实", "事实 + 记忆", "事实 + 记忆 + 状态"],
    ["召回记忆", "—", `${results.memory.recalled_memories.length} 条`, `${results.sageflow.recalled_memories.length} 条`],
    ["状态维度", "—", "—", `${Object.keys(results.sageflow.state.dimensions).length} 项`],
    ["最终选择", labelForAction(results.baseline.selected_action.action_type), labelForAction(results.memory.selected_action.action_type), labelForAction(results.sageflow.selected_action.action_type)],
    ["打扰成本", pct(results.baseline.selected_action.interruption_cost), pct(results.memory.selected_action.interruption_cost), pct(results.sageflow.selected_action.interruption_cost)],
    ["决策净分", results.baseline.decision.selected_score.toFixed(2), results.memory.decision.selected_score.toFixed(2), results.sageflow.decision.selected_score.toFixed(2)]
  ];
  return `<table class="comparison-table"><thead><tr><th>比较维度</th><th>Baseline</th><th>Memory</th><th class="sage-col">SageFlow</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<${index ? "td" : "th"} class="${index === 3 ? "sage-col" : ""}">${esc(cell)}</${index ? "td" : "th"}>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function evalCaseTable() {
  const report = cycleEvaluationReport;
  return `<div class="case-table"><div class="case-head"><span>场景</span><span>协议</span><span>记忆</span><span>状态</span><span>决策</span><span>追踪</span><span>反馈</span><span>结果</span></div>${report.cases.map((item) => `<div class="case-row ${item.scenario_id === ui.scenarioId ? "current" : ""}" data-scenario="${item.scenario_id}"><span><b>${item.scenario_id}</b>${esc(item.title)}</span>${Object.values(item.checks).map((pass) => `<span class="check ${pass ? "pass" : "fail"}">${pass ? "✓" : "×"}</span>`).join("")}<span class="case-result">${item.passed ? "通过" : "失败"}</span></div>`).join("")}</div>`;
}

function variantC() {
  const results = modeResults();
  return `
    ${appHeader("评测")}
    <main class="variant-c page-shell">
      <div class="matrix-heading"><div><span class="eyebrow">EVALUATION MATRIX · VARIANT C</span><h1>每一个能力，都要有同期证据</h1><p>把模式差异、协议门禁和失败轨迹放在同一张工作台上。</p></div><div class="matrix-actions"><select id="scenario-select">${scenarioOptions()}</select><button class="primary" data-action="run-all">运行当前场景</button><button data-action="reset">重置</button></div></div>
      ${evaluationPanel()}
      ${memoryEvaluationPanel()}
      <div class="matrix-grid">
        <section class="panel comparison-matrix"><div class="panel-heading"><span>${scenario().id} · ${esc(scenario().title)}</span><small>${esc(scenario().summary)}</small></div>${comparisonTable(results)}</section>
        <section class="panel selected-decision"><div class="panel-heading"><span>SageFlow 决策</span><b>${labelForAction(results.sageflow.selected_action.action_type)}</b></div><blockquote>${esc(results.sageflow.selected_action.message)}</blockquote><div class="decision-bars"><span>用户价值<i><b style="width:${pct(results.sageflow.selected_action.expected_user_value)}"></b></i><em>${pct(results.sageflow.selected_action.expected_user_value)}</em></span><span>打扰成本<i><b style="width:${pct(results.sageflow.selected_action.interruption_cost)}"></b></i><em>${pct(results.sageflow.selected_action.interruption_cost)}</em></span><span>风险<i><b style="width:${pct(results.sageflow.selected_action.risk)}"></b></i><em>${pct(results.sageflow.selected_action.risk)}</em></span></div><p>${esc(results.sageflow.decision.decision_reason)}</p></section>
      </div>
      <section class="panel case-regression"><div class="panel-heading"><span>8 个确定性场景回归</span><small>点击场景切换当前情境</small></div>${evalCaseTable()}</section>
      <div class="trace-matrix"><section class="panel"><div class="panel-heading"><span>事件轨迹</span></div>${eventTimeline()}</section><section class="panel"><div class="panel-heading"><span>状态证据</span></div>${stateInspector(results.sageflow)}</section><section class="panel"><div class="panel-heading"><span>候选行动</span></div><div class="candidate-list">${results.sageflow.candidates.map((action) => `<div class="candidate ${action.action_id === results.sageflow.selected_action.action_id ? "selected" : ""}"><span>${labelForAction(action.action_type)}</span><b>${(action.expected_user_value - action.interruption_cost - action.risk).toFixed(2)}</b><small>${action.reason_codes.join(" · ")}</small></div>`).join("")}</div></section></div>
    </main>
    ${variantSwitcher()}`;
}

function variantSwitcher() {
  return `<div class="variant-switcher" role="navigation" aria-label="原型变体切换"><button data-variant-step="-1" aria-label="上一个变体">←</button><span><small>界面原型</small><b>${ui.variant} · ${variantNames[ui.variant]}</b></span><button data-variant-step="1" aria-label="下一个变体">→</button></div>`;
}

function render() {
  document.getElementById("app").innerHTML = ui.variant === "B" ? variantB() : ui.variant === "C" ? variantC() : variantA();
  bindEvents();
}

function changeVariant(direction) {
  const variants = ["A", "B", "C"];
  const next = (variants.indexOf(ui.variant) + direction + variants.length) % variants.length;
  ui.variant = variants[next];
  const url = new URL(location.href);
  url.searchParams.set("variant", ui.variant);
  history.replaceState({}, "", url);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function bindEvents() {
  document.getElementById("scenario-select")?.addEventListener("change", async (event) => {
    ui.scenarioId = event.target.value;
    resetSession();
    await initializeMemoryRuntime();
    render();
  });
  document.querySelectorAll("[data-scenario]").forEach((element) => element.addEventListener("click", async () => {
    ui.scenarioId = element.dataset.scenario;
    resetSession();
    await initializeMemoryRuntime();
    render();
  }));
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.action === "advance") {
      const next = scenario().timeline[ui.session.cursor];
      advanceSession(ui.session);
      if (next) await observeMemory([next]);
      ui.eventNotice = next ? `已注入：${next.payload.description}` : "没有更多事件。";
    } else if (button.dataset.action === "run-all") {
      const remaining = scenario().timeline.slice(ui.session.cursor);
      runToEnd(ui.session);
      await observeMemory(remaining);
      ui.eventNotice = "已运行全部事件，可以比较决策并注入反馈。";
    } else {
      resetSession();
      await initializeMemoryRuntime();
    }
    render();
  }));
  document.querySelectorAll("[data-focus-mode]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    ui.focusMode = button.dataset.focusMode;
    render();
  }));
  document.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", async () => {
    const currentDecision = modeResults().sageflow.decision.decision_id;
    const feedbackEvent = applyFeedback(ui.session, button.dataset.feedback, currentDecision);
    await observeMemory([feedbackEvent]);
    ui.eventNotice = `已记录反馈：${button.textContent.trim()}`;
    render();
  }));
  document.querySelectorAll("[data-variant-step]").forEach((button) => button.addEventListener("click", () => changeVariant(Number(button.dataset.variantStep))));
  document.querySelectorAll("[data-mode]").forEach((card) => card.addEventListener("click", () => {
    ui.focusMode = card.dataset.mode;
    render();
  }));
}

document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.activeElement?.isContentEditable) return;
  if (event.key === "ArrowLeft") changeVariant(-1);
  if (event.key === "ArrowRight") changeVariant(1);
});

render();
