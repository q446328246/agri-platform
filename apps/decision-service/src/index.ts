/** @agri/decision-service 公共入口 */
export { createDecisionHttpServer } from "./http.js";
export type { DecisionDependencies } from "./http.js";
export { RuleEngine, matchesRule } from "./rule.engine.js";
export type { RuleEvaluationInput, RuleEvaluationResult, MatchedRule } from "./rule.engine.js";
export { InMemoryRuleRepository, SqlRuleRepository, defaultRule } from "./rule.repository.js";
export type { Rule, RuleRepository, RuleType, RuleCondition, RuleAction } from "./rule.repository.js";
export { SqlPrescriptionRepository, InMemoryPrescriptionRepository, newPrescriptionId } from "./prescription.repository.js";
export type { PrescriptionRecord, PrescriptionItem, PrescriptionRepository, PrescriptionStatus } from "./prescription.repository.js";
export { SqlOutboxStore } from "./outbox.repository.js";
