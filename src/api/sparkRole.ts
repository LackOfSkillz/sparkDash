import type { InferenceTopology, SparkRole } from "./types";

/** Narrow shape accepted by the resolvers: config fields plus, optionally, observed telemetry. */
interface RoleInput {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  metrics?: { inferenceTopology?: InferenceTopology | null } | null;
}

function asRole(value: unknown): SparkRole | null {
  return value === "head" || value === "worker" || value === "standalone" ? value : null;
}

/**
 * Resolve cluster role, preferring what is RUNNING over what was typed.
 *
 * WHY OBSERVATION OUTRANKS CONFIGURATION
 * --------------------------------------
 * This used to read `role` from config alone, which defaults to "standalone" when
 * unset. Nothing consulted reality, so a live two-node tensor-parallel deployment
 * rendered as two unrelated standalone boxes and no amount of cluster activity could
 * correct it. Config could not be treated as a mere fallback either, because an unset
 * role and a deliberate "standalone" are stored identically — on this fleet both nodes
 * sat at an explicit "standalone" while actually serving ranks 0 and 1 of one model.
 *
 * So the serving engine's own command line wins: it states `--nnodes 2 --node-rank 0`
 * and cannot be stale, because it IS the running process. Configuration remains the
 * answer whenever no engine was observed — an unreachable or docker-less host has told
 * us nothing, and silence must not be read as "standalone".
 */
export function resolveSparkRole(spark: RoleInput): SparkRole {
  const observed = asRole(spark.metrics?.inferenceTopology?.role);
  if (observed) return observed;
  const configured = asRole(spark.role);
  if (configured) return configured;
  return spark.workerNode ? "worker" : "standalone";
}

/** True when the role came from observed telemetry rather than configuration. */
export function isRoleObserved(spark: RoleInput): boolean {
  return asRole(spark.metrics?.inferenceTopology?.role) !== null;
}

/**
 * Whether this Spark should probe/show the local LLM API.
 * Workers: never. Head: always. Standalone: llmMonitoring (default true).
 */
export function isLlmMonitoringEnabled(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
  metrics?: { inferenceTopology?: InferenceTopology | null } | null;
}): boolean {
  const role = resolveSparkRole(spark);
  if (role === "worker") return false;
  if (role === "head") return true;
  return spark.llmMonitoring !== false;
}
