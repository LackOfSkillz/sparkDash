/**
 * Inference topology — is this node serving alone, or is it one rank of a cluster?
 *
 * WHY THIS EXISTS
 * ---------------
 * Cluster-vs-standalone used to be decided purely by a `role` field a human typed
 * into config, defaulting to "standalone" when unset. Nothing in the detection path
 * ever looked at what was actually running, so a genuine two-node tensor-parallel
 * deployment rendered as two unrelated standalone boxes, and no amount of real
 * cluster activity could correct it. Worse, the default and a deliberate choice are
 * indistinguishable once stored, so "standalone" could never be safely overridden.
 *
 * The serving engine already knows the answer and states it on its own command line:
 * `--nnodes 2 --node-rank 0` is a head, `--node-rank 1 --headless` is a worker.
 * This collector reads that and reports it as fact.
 *
 * WHY docker inspect AND NOT ps
 * -----------------------------
 * The engine usually runs in a container with its own PID namespace, so the host
 * process table does not contain it. What the host table DOES often contain is a
 * *different*, unrelated engine — an embedding server, say — whose single-node
 * arguments would then be mistaken for the topology of the cluster deployment. On
 * this fleet that is exactly what happens: `ps` matches a `--max-model-len 8192`
 * embedding server while the real DS4 rank lives in Docker. So containers are
 * inspected first, the host table is only a fallback, and when several engines are
 * found the most topological one wins (see {@link pickPrimaryTopology}).
 *
 * Both vLLM and SGLang are matched, since the dashboard probes both.
 */

/** Shell fragment listing every engine command line on the host, containers first. */
export function inferenceTopologyProbeCommand() {
  return [
    // Containers. `docker ps -q` is empty (not an error) where docker is absent or
    // the user cannot reach the socket, so hosts without it simply emit nothing.
    "for c in $(docker ps -q 2>/dev/null | head -24); do",
    'a=$(docker inspect --format "{{range .Config.Cmd}}{{.}} {{end}}{{range .Args}}{{.}} {{end}}" "$c" 2>/dev/null | tr -s "[:space:]" " ");',
    'case "$a" in *"vllm serve"*|*sglang.launch_server*|*"vllm.entrypoints"*)',
    'echo "src=docker"; echo "args=$a"; echo "end=1";; esac;',
    "done;",
    // Host fallback, for a bare-metal launch. Several are possible; all are emitted
    // and the parser decides which one describes the cluster.
    'ps -eo args 2>/dev/null | grep -a -e "vllm serve" -e "sglang.launch_server" -e "vllm.entrypoints" | grep -av grep | head -4 | while IFS= read -r l; do',
    '[ -n "$l" ] && { echo "src=host"; echo "args=$l"; echo "end=1"; };',
    "done",
  ].join(" ");
}

/** Integer flag value, tolerating `--flag N` and `--flag=N`. */
function flagInt(args, ...names) {
  for (const name of names) {
    const re = new RegExp(name + "(?:[= 	]+)([0-9]+)");
    const m = args.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function hasFlag(args, name) {
  return new RegExp(name + "(?![A-Za-z0-9_-])").test(args);
}

/** One engine command line -> its topology, or null when it says nothing useful. */
export function parseEngineArgs(args, source = null) {
  if (!args || typeof args !== "string") return null;
  const engine = /sglang/.test(args) ? "sglang" : /vllm/.test(args) ? "vllm" : null;
  if (!engine) return null;
  return {
    engine,
    source,
    // `-tp` is vLLM's short form; `--tp-size` is SGLang's spelling.
    tpSize: flagInt(args, "--tensor-parallel-size", "--tp-size", "-tp"),
    ppSize: flagInt(args, "--pipeline-parallel-size", "--pp-size"),
    nnodes: flagInt(args, "--nnodes"),
    nodeRank: flagInt(args, "--node-rank"),
    headless: hasFlag(args, "--headless"),
  };
}

/** Parse the block output of {@link inferenceTopologyProbeCommand}. */
export function parseInferenceTopologyOutput(output) {
  if (!output || typeof output !== "string") return [];
  const found = [];
  let src = null;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("src=")) src = line.slice(4).trim() || null;
    else if (line.startsWith("args=")) {
      const parsed = parseEngineArgs(line.slice(5), src);
      if (parsed) found.push(parsed);
    }
  }
  return found;
}

/**
 * Which of several engines on one host describes the cluster.
 *
 * A node can legitimately run more than one: a cluster rank plus a small embedding
 * server, for instance. The multi-node one is the answer; ranking by `nnodes` first
 * means a co-resident single-node engine can never mask a cluster membership.
 */
export function pickPrimaryTopology(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const score = (t) =>
    (t.nnodes && t.nnodes > 1 ? 100 : 0) +
    (t.headless ? 50 : 0) +
    (t.nodeRank !== null ? 10 : 0) +
    (t.tpSize && t.tpSize > 1 ? 5 : 0) +
    (t.source === "docker" ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Role implied by observed topology, or null when nothing was observed.
 *
 * Returning null rather than guessing "standalone" is deliberate: an unreachable or
 * docker-less host has told us nothing, and must fall back to configuration instead
 * of having its configured role overwritten by an absence of evidence.
 */
export function topologyRole(topology) {
  if (!topology) return null;
  const { nnodes, nodeRank, headless } = topology;
  if (nnodes !== null && nnodes > 1) return nodeRank !== null && nodeRank > 0 ? "worker" : "head";
  // A headless rank is a worker even if --nnodes was left implicit.
  if (headless) return "worker";
  return "standalone";
}

/** Full detection result for one host, ready to attach to a snapshot. */
export function detectTopology(output) {
  const primary = pickPrimaryTopology(parseInferenceTopologyOutput(output));
  if (!primary) return null;
  return { ...primary, role: topologyRole(primary) };
}
