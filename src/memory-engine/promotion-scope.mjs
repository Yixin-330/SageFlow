import { scopeRelation } from "./conflict-semantics.mjs";

const TRIP_KINDS = new Set(["leisure_trip", "business_trip", "family_trip", "solo_trip"]);
const CONTEXT_TAGS = new Set(["city_break", "with_child", "single_activity"]);

export function legacyPromotionSituation(token) {
  if (TRIP_KINDS.has(token)) return { field: "trip_kind", value: token };
  if (CONTEXT_TAGS.has(token)) return { field: token, value: true };
  return null;
}

export function comparablePromotionScope(scope = {}) {
  if (!Array.isArray(scope.applies_when) || !scope.applies_when.length) return scope;
  const mapped = scope.applies_when.map(legacyPromotionSituation);
  if (mapped.some((item) => !item)) return null;
  const situations = [...(scope.situations ?? []), ...mapped];
  const byField = new Map();
  for (const item of situations) {
    if (byField.has(item.field) && JSON.stringify(byField.get(item.field)) !== JSON.stringify(item.value)) return null;
    byField.set(item.field, item.value);
  }
  return { ...scope, applies_when: undefined,
    situations: [...byField].map(([field, value]) => ({ field, value }))
      .sort((a, b) => a.field.localeCompare(b.field)) };
}

export function promotionScopeRelation(left, right) {
  const a = comparablePromotionScope(left);
  const b = comparablePromotionScope(right);
  if (!a || !b) return "unknown";
  return scopeRelation(a, b);
}
