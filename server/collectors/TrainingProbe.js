/**
 * TrainingProbe — reports what a Spark is TRAINING, not just what it is serving.
 *
 * A node running a fine-tune looks identical to an idle one in every panel we
 * had: the LLM probe finds no endpoint (there isn't one), so the cluster reads
 * DEGRADED while the GPU sits at 95% doing the most expensive work the machine
 * will do all week. This fills that hole.
 *
 * Progress is read from two places because neither alone is enough:
 *   - trainer_state.json is authoritative for loss and step, but Hugging Face
 *     only rewrites it when a checkpoint is saved, so between saves it is stale.
 *   - the tqdm bar in the run log is live to the step, but carries no loss.
 *
 * The tqdm bar needs care. An HF run prints a SECOND bar for evaluation, and
 * during eval that bar is the most recent thing in the log -- taking the last
 * match reports "83/200" (the eval set) while training is really at step
 * 100/1000. Bars are therefore matched against max_steps, and a non-matching
 * trailing bar is read as "currently evaluating" rather than as progress.
 */
import { sshExec } from "./ssh.js";

/** Emits one JSON object describing any active HF Trainer run. */
const REMOTE = String.raw`
import json, os, re, glob

def out(d):
    print("__TRAINPROBE__" + json.dumps(d))

res = {"active": False}
procs = []
self_pid = os.getpid()
self_ppid = os.getppid()
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) in (self_pid, self_ppid):
        continue
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            cmd = fh.read().decode("utf-8", "replace").replace("\x00", " ").strip()
        if not cmd or "python" not in cmd:
            continue
        if not re.search(r"train[\w-]*\.py", cmd):
            continue
        st = os.stat(f"/proc/{pid}")
        procs.append((st.st_mtime, int(pid), cmd))
    except (OSError, IOError):
        continue

if not procs:
    out(res)
    raise SystemExit

# Dataloader workers share the parent's cmdline; the oldest process is the run.
procs.sort()
_, pid, cmd = procs[0]
try:
    cwd = os.readlink(f"/proc/{pid}/cwd")
except OSError:
    cwd = None

res.update({"active": True, "pid": pid, "cwd": cwd})
m = re.search(r"([\w-]*train[\w-]*\.py)", cmd)
res["script"] = m.group(1) if m else None
m = re.search(r"--max-steps[= ]+(\d+)", cmd)
max_steps = int(m.group(1)) if m else None

state, newest = None, 0
for p in glob.glob(os.path.join(cwd or ".", "**", "trainer_state.json"), recursive=True):
    try:
        t = os.path.getmtime(p)
    except OSError:
        continue
    if t > newest:
        newest, state = t, p

if state:
    try:
        with open(state) as fh:
            s = json.load(fh)
        hist = [h for h in s.get("log_history", []) if "loss" in h]
        res["step"] = s.get("global_step")
        max_steps = max_steps or s.get("max_steps") or None
        if hist:
            res["loss"] = round(hist[-1]["loss"], 4)
            res["firstLoss"] = round(hist[0]["loss"], 4)
        res["outputDir"] = os.path.dirname(os.path.dirname(state))
        res["checkpoints"] = len(glob.glob(os.path.join(res["outputDir"], "checkpoint-*")))
        ev = [h for h in s.get("log_history", []) if "eval_loss" in h]
        if ev:
            res["evalLoss"] = round(ev[-1]["eval_loss"], 4)
    except (OSError, ValueError):
        pass

res["maxSteps"] = max_steps

# Live step from the tqdm bar. Match on max_steps so the eval bar cannot be
# mistaken for training progress.
bar = re.compile(r"(\d+)/(\d+) \[([\d:]+)<([\d:]+), +([\d.]+)(s/it|it/s)")
best, evaluating = None, False
for log in glob.glob(os.path.join(cwd or ".", "*.log")):
    try:
        with open(log, "rb") as fh:
            try:
                fh.seek(-400000, os.SEEK_END)
            except OSError:
                fh.seek(0)
            text = fh.read().decode("utf-8", "replace").replace("\r", "\n")
    except OSError:
        continue
    hits = bar.findall(text)
    if not hits:
        continue
    if max_steps:
        mine = [h for h in hits if int(h[1]) == max_steps]
        if mine:
            cand = mine[-1]
            if os.path.getmtime(log) >= (best[0] if best else 0):
                best = (os.path.getmtime(log), cand)
            # a trailing non-matching bar means an eval loop is in flight
            if hits[-1][1] != str(max_steps):
                evaluating = True

if best:
    step, total, elapsed, remain, rate, unit = best[1]
    res["step"] = int(step)
    res["maxSteps"] = int(total)
    res["elapsed"] = elapsed
    res["remaining"] = remain
    res["secPerStep"] = round(float(rate) if unit == "s/it" else 1 / float(rate), 2)

if res.get("step") and res.get("maxSteps"):
    res["pct"] = round(100.0 * res["step"] / res["maxSteps"], 1)

# A process whose name merely matches train*.py proves nothing. Require real
# evidence -- a trainer_state.json or a progress bar -- before reporting a run,
# so an unrelated script cannot light up the dashboard as a fine-tune.
if state is None and best is None:
    out({"active": False})
    raise SystemExit

res["phase"] = "evaluating" if evaluating else "training"
out(res)
`;

export class TrainingProbe {
  constructor(spark) {
    this.spark = spark;
    this.reset();
  }

  reset() {
    this.active = false;
    this.script = null;
    this.model = null;
    this.step = null;
    this.maxSteps = null;
    this.pct = null;
    this.loss = null;
    this.firstLoss = null;
    this.evalLoss = null;
    this.secPerStep = null;
    this.remaining = null;
    this.checkpoints = null;
    this.outputDir = null;
    this.phase = null;
  }

  async probe() {
    let raw;
    try {
      const b64 = Buffer.from(REMOTE, "utf8").toString("base64");
      // Base64 so the script survives the shell without quoting damage.
      raw = await sshExec(this.spark, `echo ${b64} | base64 -d | python3 -`, { timeout: 20000 });
    } catch {
      this.reset();
      return this.toJSON();
    }
    const line = String(raw || "")
      .split("\n")
      .find((l) => l.includes("__TRAINPROBE__"));
    if (!line) {
      this.reset();
      return this.toJSON();
    }
    let data;
    try {
      data = JSON.parse(line.slice(line.indexOf("__TRAINPROBE__") + 14));
    } catch {
      this.reset();
      return this.toJSON();
    }
    this.reset();
    Object.assign(this, data);
    return this.toJSON();
  }

  toJSON() {
    return {
      active: !!this.active,
      script: this.script ?? null,
      step: this.step ?? null,
      maxSteps: this.maxSteps ?? null,
      pct: this.pct ?? null,
      loss: this.loss ?? null,
      firstLoss: this.firstLoss ?? null,
      evalLoss: this.evalLoss ?? null,
      secPerStep: this.secPerStep ?? null,
      remaining: this.remaining ?? null,
      checkpoints: this.checkpoints ?? null,
      outputDir: this.outputDir ?? null,
      phase: this.phase ?? null,
    };
  }
}
