# SageFlow User Intelligence

SageFlow User Intelligence describes how travel observations become durable user understanding and appropriately timed assistance.

## Language

**Observation Event**:
An immutable fact observed at a particular time, such as a weather update, user statement, movement signal, or interaction result.
_Avoid_: State, memory

**Decision Context**:
The temporary, point-in-time view assembled for one decision from recent events, recalled memories, live signals, permissions, and trip constraints.
_Avoid_: Context memory, permanent context

**Memory Item**:
A revisable claim about the user or a past travel episode, supported by evidence and bounded by confidence, scope, and time.
_Avoid_: User fact, profile field

**Memory Tier**:
The retention horizon of a Memory Item: short-term within a trip or limited period, or long-term across trips.
_Avoid_: Memory type

**Memory Domain**:
Whose enduring understanding a Memory Item describes: the user, the relationship with SageFlow, or a shared travel context.
_Avoid_: Scope, topic

**Memory Kind**:
The semantic form of a Memory Item: an episode, a generalized claim, or a learned way of serving the user.
_Avoid_: Memory tier

**Short-term Memory**:
A Memory Item whose scope is the current trip or a limited period, such as today's desired pace.
_Avoid_: Context

**Long-term Memory**:
A Memory Item supported strongly enough to remain useful across trips while still being correctable and time-sensitive.
_Avoid_: Permanent preference

**Episodic Memory**:
A bounded account of something that happened during a particular travel situation.
_Avoid_: Event log

**Semantic Memory**:
A generalized, evidence-bearing claim about preferences, constraints, habits, or relationship expectations.
_Avoid_: Profile field

**Procedural Memory**:
A learned policy for how SageFlow should serve this user under declared conditions.
_Avoid_: Global product rule, prompt instruction

**Pending Memory Candidate**:
A Memory Candidate retained for more evidence because it is not safe or well-supported enough to become a Memory Item.
_Avoid_: Low-confidence memory

**Memory Edge**:
An evidence-bearing relationship between memories or between a memory and its source, version, exception, conflict, decision, or feedback.
_Avoid_: Tag

**State Snapshot**:
A time-limited inference about the user's present condition or intent, with evidence and calibrated uncertainty.
_Avoid_: User fact, memory

**Action Candidate**:
One possible response to the current Decision Context, including remaining silent.
_Avoid_: Final action

**Decision Record**:
The auditable selection among Action Candidates after value, interruption, permission, safety, and risk constraints are applied.
_Avoid_: Model answer

**Action Execution**:
An attempt to carry out the selected action through a user-facing or external service channel.
_Avoid_: Decision

**Feedback Event**:
An explicit or implicit observation of what happened after an action, without assuming why it happened.
_Avoid_: Preference update

**Memory Mutation**:
A proposed and traceable change to a Memory Item: create, reinforce, weaken, supersede, merge, or expire.
_Avoid_: Overwrite

**Memory Candidate**:
A model- or rule-proposed interpretation of one or more Observation Events that has not yet passed storage, sensitivity, scope, or conflict policy.
_Avoid_: New memory

**Conflict Set**:
A group of incompatible Memory Items that remain visible until context, stronger evidence, or explicit user correction resolves their applicability.
_Avoid_: Duplicate memory, latest value

**Recall Bundle**:
The evidence-bearing set of included, conflicted, and omitted Memory Items assembled for a declared decision purpose.
_Avoid_: Prompt context

**Silent Action**:
An explicit decision not to interrupt the user because action value does not exceed interruption cost or a constraint blocks intervention.
_Avoid_: No result, failure

**Baseline Mode**:
The comparison condition that uses only current conversation and current observable facts.

**Memory Mode**:
The comparison condition that adds recalled user memory but does not infer dynamic user state or make controlled proactive decisions.

**SageFlow Mode**:
The full condition that combines current observations, recalled memory, dynamic state, and constrained proactive decision-making.
