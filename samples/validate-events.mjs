// Checks an event log against docs/CONTRACT.md.
// Run: node samples/validate-events.mjs <file.jsonl> [more files]
// Exit code 0 when every file is clean, 1 otherwise.
import { readFileSync } from "node:fs";

const KNOWN = new Set([
  "room.created", "room.paused", "room.resumed", "room.closed",
  "member.joined", "member.left",
  "message.posted", "route.decided", "route.rejected",
  "task.created", "task.claimed", "task.updated", "task.review", "task.done", "task.failed", "task.cancelled",
  "artifact.registered",
  "run.started", "run.output", "run.completed", "run.failed", "run.cancelled",
  "tool.called", "tool.result",
  "shelflife.claim.extracted", "shelflife.search.completed", "shelflife.verdict.proposed",
  "shelflife.check.result", "shelflife.verdict.final", "shelflife.patch.proposed",
  "shelflife.pr.opened", "shelflife.pr.updated", "shelflife.review.result",
]);
const MODES = new Set(["human", "api", "cli", "external_mcp", "local_model", "system"]);
const IDENTITY = new Set(["configured", "provider_reported", "self_reported"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NEEDS_CLAIM = new Set(["shelflife.claim.extracted", "shelflife.search.completed", "shelflife.verdict.proposed", "shelflife.check.result", "shelflife.verdict.final"]);

function checkUsage(u, where, problems) {
  if (!u || typeof u !== "object") return problems.push(`${where}: usage missing`);
  for (const k of ["inputTokens", "outputTokens", "costUsd"]) {
    if (!(k in u)) problems.push(`${where}: usage.${k} missing (use null when unknown)`);
    else if (u[k] !== null && typeof u[k] !== "number") problems.push(`${where}: usage.${k} must be a number or null`);
  }
  if (!["provider", "estimated", "unknown"].includes(u.source)) problems.push(`${where}: usage.source invalid`);
  if (u.source === "unknown" && [u.inputTokens, u.outputTokens, u.costUsd].some((v) => v !== null)) {
    problems.push(`${where}: usage.source is "unknown" but a number is given`);
  }
}

function validate(file) {
  const problems = [];
  const warnings = [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const ids = new Set();
  const members = new Set();
  let expectSeq = 1;
  let roomId = null;
  let lastTs = "";
  lines.forEach((line, i) => {
    const where = `line ${i + 1}`;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) warnings.push(`${where}: last line is not valid JSON (cut off by a crash?); skipped`);
      else problems.push(`${where}: not valid JSON`);
      return;
    }
    if (e.schemaVersion !== 1) problems.push(`${where}: schemaVersion must be 1`);
    for (const k of ["eventId", "roomId", "type", "timestamp"]) {
      if (typeof e[k] !== "string" || !e[k]) problems.push(`${where}: ${k} missing`);
    }
    if (e.seq !== expectSeq) problems.push(`${where}: seq is ${e.seq}, expected ${expectSeq}`);
    expectSeq = (typeof e.seq === "number" ? e.seq : expectSeq) + 1;
    if (ids.has(e.eventId)) problems.push(`${where}: duplicate eventId ${e.eventId}`);
    ids.add(e.eventId);
    if (roomId === null) roomId = e.roomId;
    else if (e.roomId !== roomId) problems.push(`${where}: roomId changed inside one log`);
    if (!ISO.test(e.timestamp || "")) problems.push(`${where}: timestamp must be ISO 8601 UTC with milliseconds`);
    else if (e.timestamp < lastTs) problems.push(`${where}: timestamp goes backwards`);
    else lastTs = e.timestamp;
    const p = e.provenance;
    if (!p || typeof p !== "object") problems.push(`${where}: provenance missing`);
    else {
      if (!("memberId" in p)) problems.push(`${where}: provenance.memberId missing (null is allowed)`);
      if (!MODES.has(p.mode)) problems.push(`${where}: provenance.mode invalid`);
      if (!IDENTITY.has(p.identitySource)) problems.push(`${where}: provenance.identitySource invalid`);
      if (!("provider" in p) || !("model" in p)) problems.push(`${where}: provenance.provider and .model must be present (null is allowed)`);
    }
    if (!e.payload || typeof e.payload !== "object") return problems.push(`${where}: payload missing`);
    const t = e.type;
    const d = e.payload;
    if (!KNOWN.has(t)) warnings.push(`${where}: unknown type ${t} (allowed, consumers skip it)`);
    if (i === 0 && t !== "room.created") problems.push(`${where}: the first event must be room.created`);
    if (t === "room.created" && !["harness", "direct"].includes(d.driver)) problems.push(`${where}: room.created needs driver "harness" or "direct"`);
    if (t === "member.joined") members.add(d.memberId);
    if ((t.startsWith("run.") || t.startsWith("tool.")) && !e.runId) problems.push(`${where}: ${t} needs runId`);
    if (t.startsWith("task.") && !e.taskId) problems.push(`${where}: ${t} needs taskId`);
    if (NEEDS_CLAIM.has(t) && !d.claimId) problems.push(`${where}: ${t} needs payload.claimId`);
    if (t === "route.decided") {
      const deliver = new Set(d.deliverTo || []);
      for (const m of d.wake || []) if (!deliver.has(m)) problems.push(`${where}: wake contains ${m}, which is not in deliverTo`);
      for (const m of deliver) if (!members.has(m)) problems.push(`${where}: route names ${m}, who has not joined`);
      if (!["rules", "local_model", "fallback"].includes(d.source)) problems.push(`${where}: route source invalid`);
      if (typeof d.roomVersion !== "number") problems.push(`${where}: route.decided needs roomVersion`);
    }
    if (t === "run.completed" || t === "run.failed") checkUsage(d.usage, where, problems);
    if (t === "task.done" && !(Array.isArray(d.evidence) && d.evidence.length > 0)) problems.push(`${where}: task.done needs at least one piece of evidence`);
    if (t === "shelflife.verdict.final" && d.verdict === "stale") {
      const domains = new Set((d.sources || []).map((s) => s.domain));
      if (domains.size < 2) problems.push(`${where}: a final "stale" verdict needs sources from at least 2 domains`);
      if (!d.correction) problems.push(`${where}: a final "stale" verdict needs a correction`);
    }
  });
  return { count: lines.length, problems, warnings };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node samples/validate-events.mjs <file.jsonl> [more files]");
  process.exit(2);
}
let bad = false;
for (const f of files) {
  const { count, problems, warnings } = validate(f);
  for (const w of warnings) console.log(`warn  ${f}: ${w}`);
  for (const p of problems) console.log(`FAIL  ${f}: ${p}`);
  console.log(`${problems.length === 0 ? "ok   " : "FAIL "} ${f}: ${count} events, ${problems.length} problem(s), ${warnings.length} warning(s)`);
  if (problems.length) bad = true;
}
process.exit(bad ? 1 : 0);
