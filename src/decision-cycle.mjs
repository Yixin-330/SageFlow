import { evaluateModes } from "./engine.mjs";

function situationFromContext(context) {
  const weather = /雨|rain/i.test(context.weather ?? "") ? "rain" : "clear";
  const fatigue = context.selfReportedEnergy === "high" ? "low"
    : context.steps >= 10000 && context.activityEvidence ? "high" : "uncertain";
  return {
    weather,
    fatigue,
    with_child: Boolean(context.withChild),
    single_activity: Boolean(context.alternative),
    recent_ignored: context.recentIgnored ?? 0
  };
}

export function buildDecisionRecallRequest(session, { permissions = [], limit = 8 } = {}) {
  const event = session.appliedEvents.at(-1);
  const c = session.context;
  return {
    user_id: event?.user_id ?? session.memories[0]?.user_id ?? session.scenario.timeline[0]?.user_id,
    trace_id: `recall_${session.scenario.id}_${session.cursor}_${session.feedback.length}`,
    trip_id: event?.trip_id ?? session.scenario.timeline[0]?.trip_id,
    purpose: "decision",
    query_text: [c.nextPlan, c.alternative, c.weather, c.currentIntent].filter(Boolean).join(" "),
    predicates: ["prefers_travel_pace", "likes_experience", "prefers_activity_load"],
    situation: situationFromContext(c),
    permissions,
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
      const scopedSession = {
        ...session,
        memories: recall.memories.map((item) => item.memory),
        recallBundle: recall,
        servicePolicy: recall.matched_rules.find((rule) => rule.service_policy?.action === "remain_silent")?.service_policy ?? null
      };
      const modes = evaluateModes(scopedSession);
      return { request, recall, modes };
    }
  };
}
