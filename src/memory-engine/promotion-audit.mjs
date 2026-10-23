import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function promotionDecisionRecord(group, decision, evaluatedAt) {
  const evidenceEventIds = [...new Set([...(group.evidence_event_ids ?? []),
    ...(group.confirmation ? [group.confirmation.event_id] : [])])].sort();
  const evidenceHash = hash(evidenceEventIds);
  return {
    decision_id: `pdec_${hash({ user_id: group.user_id, group_id: group.group_id,
      generation: group.generation, action: decision.action, reason_code: decision.reason_code,
      policy_version: decision.policy_version, evidence_hash: evidenceHash, evaluated_at: evaluatedAt })}`,
    user_id: group.user_id, group_id: group.group_id, generation: group.generation,
    action: decision.action, reason_code: decision.reason_code, reason_codes: [decision.reason_code],
    policy_version: decision.policy_version, target_scope: decision.target_scope ?? null,
    evidence_event_ids: evidenceEventIds, evidence_hash: evidenceHash,
    evaluated_at: evaluatedAt, promotion_key: decision.promotion_key ?? null
  };
}
