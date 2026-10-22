import { evaluateModes } from "./engine.mjs";
import { auditDecisionTrace } from "./decision-trace-audit.mjs";
import { buildDecisionContext } from "./decision-context.mjs";

function situationFromContext(context, scopeTags = []) {
  const weather = /雨|rain/i.test(context.weather ?? "") ? "rain" : "clear";
  const fatigue = context.selfReportedEnergy === "high" ? "low"
    : context.steps >= 10000 && context.activityEvidence ? "high" : "uncertain";
  return {
    weather,
    fatigue,
    with_child: Boolean(context.withChild),
    single_activity: Boolean(context.alternative),
    recent_ignored: context.recentIgnored ?? 0,
    ...(scopeTags.length ? { trip_kind: scopeTags[0] } : {}),
    ...Object.fromEntries(scopeTags.map((tag) => [tag, true]))
  };
}

export function buildDecisionRecallRequest(session, { permissions = [], limit = 8, current_state = null } = {}) {
  const event = [...session.appliedEvents, ...session.feedback]
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))[0];
  const c = session.context;
  return {
    user_id: event?.user_id ?? session.memories[0]?.user_id ?? session.scenario.timeline[0]?.user_id,
    trace_id: `recall_${session.scenario.id}_${session.cursor}_${session.feedback.length}`,
    trip_id: event?.trip_id ?? session.scenario.timeline[0]?.trip_id,
    purpose: "decision",
    query_text: [c.nextPlan, c.alternative, c.weather, c.currentIntent].filter(Boolean).join(" "),
    predicates: ["prefers_travel_pace", "likes_experience", "prefers_activity_load"],
    situation: situationFromContext(c, session.scenario.scope_tags),
    permissions,
    ...(current_state ? { current_state } : {}),
    limit
  };
}

export function createDecisionCycle({ memoryEngine }) {
  if (!memoryEngine?.recall) throw new Error("Decision cycle requires a Memory Engine recall interface");
  return {
    async evaluate(session, options = {}) {
      const request = buildDecisionRecallRequest(session, options);
      if (!request.user_id) throw new Error("Decision cycle requires a user_id from the scenario or events");
      const recall = await memoryEngine.recall(request);
      const decisionContext = buildDecisionContext(session, request, recall);
      const scopedSession = {
        ...session,
        memories: recall.memories.map((item) => item.memory),
        recallBundle: recall,
        decisionContext,
        servicePolicy: recall.matched_rules.find((rule) => rule.service_policy?.action === "remain_silent")?.service_policy ?? null
      };
      const modes = evaluateModes(scopedSession);
      return { request, recall, decisionContext, modes, audit: auditDecisionTrace(session, recall, modes) };
    }
  };
}
