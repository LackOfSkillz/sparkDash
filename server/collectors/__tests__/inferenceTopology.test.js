import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectTopology,
  inferenceTopologyProbeCommand,
  parseEngineArgs,
  parseInferenceTopologyOutput,
  pickPrimaryTopology,
  topologyRole,
} from "../inferenceTopology.js";

/** Output shaped like the real probe: the container rank first, then host processes. */
function probeOutput(containerArgs, hostArgs = []) {
  const blocks = [];
  if (containerArgs) blocks.push(`src=docker\nargs=${containerArgs}\nend=1`);
  for (const h of hostArgs) blocks.push(`src=host\nargs=${h}\nend=1`);
  return blocks.join("\n");
}

const HEAD_RANK = "vllm serve /models/ds4 --tensor-parallel-size 2 --pipeline-parallel-size 1 --nnodes 2 --node-rank 0 --port 8888";
const WORKER_RANK = "vllm serve /models/ds4 --tensor-parallel-size 2 --nnodes 2 --node-rank 1 --headless";
// A small single-node engine that legitimately shares the box with a cluster rank.
const EMBEDDING = "vllm serve /home/gary/models/bge-m3 --max-model-len 8192 --port 8001";

test("rank 0 of a multi-node deployment is the head", () => {
  const t = detectTopology(probeOutput(HEAD_RANK));
  assert.equal(t.role, "head");
  assert.equal(t.nnodes, 2);
  assert.equal(t.nodeRank, 0);
  assert.equal(t.tpSize, 2);
});

test("a non-zero headless rank is a worker", () => {
  const t = detectTopology(probeOutput(WORKER_RANK));
  assert.equal(t.role, "worker");
  assert.equal(t.headless, true);
});

test("a co-resident embedding server never masks cluster membership", () => {
  // The regression this collector exists for: the host process table matches an
  // unrelated single-node engine, whose args would otherwise read as "standalone"
  // and hide a live cluster rank.
  for (const rank of [HEAD_RANK, WORKER_RANK]) {
    const t = detectTopology(probeOutput(rank, [EMBEDDING, EMBEDDING]));
    assert.equal(t.nnodes, 2, "the multi-node engine must win");
    assert.notEqual(t.role, "standalone");
  }
});

test("a lone single-node engine is standalone", () => {
  assert.equal(detectTopology(probeOutput(null, [EMBEDDING])).role, "standalone");
});

test("silence yields null, never a guess", () => {
  // An unreachable or docker-less host must fall back to configuration rather than
  // having its role overwritten by an absence of evidence.
  assert.equal(detectTopology(""), null);
  assert.equal(detectTopology("bash: docker: command not found"), null);
  assert.equal(topologyRole(null), null);
});

test("SGLang flag spellings are understood", () => {
  const t = detectTopology(probeOutput(null, ["python3 -m sglang.launch_server --tp-size 4 --nnodes 2 --node-rank 1"]));
  assert.equal(t.engine, "sglang");
  assert.equal(t.tpSize, 4);
  assert.equal(t.role, "worker");
});

test("--flag=value is parsed as well as --flag value", () => {
  const t = parseEngineArgs("vllm serve m --tensor-parallel-size=8 --nnodes=2 --node-rank=0");
  assert.equal(t.tpSize, 8);
  assert.equal(t.nnodes, 2);
  assert.equal(t.nodeRank, 0);
});

test("a single-node deployment with explicit --nnodes 1 is standalone", () => {
  assert.equal(topologyRole(parseEngineArgs("vllm serve m --nnodes 1 --node-rank 0")), "standalone");
});

test("parse yields one record per engine and ignores junk lines", () => {
  const out = probeOutput(HEAD_RANK, [EMBEDDING]) + "\nsome unrelated stderr\n";
  assert.equal(parseInferenceTopologyOutput(out).length, 2);
  assert.equal(pickPrimaryTopology([]), null);
});

test("probe command inspects containers and tolerates a docker-less host", () => {
  const cmd = inferenceTopologyProbeCommand();
  assert.match(cmd, /docker ps -q/);
  assert.match(cmd, /docker inspect/);
  assert.match(cmd, /2>\/dev\/null/);
});
