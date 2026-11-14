// Writes samples/shelf-life-room.sample.jsonl: a SYNTHETIC room log that follows
// docs/CONTRACT.md. Nothing in it was produced by a real model or a real search.
// It exists so the workbench, the loader and the evaluation can be built before
// the real workflow runs. Run: node samples/generate-sample.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const roomId = "room_sample_shelflife";
let seq = 0;
let clock = Date.parse("2026-11-14T16:00:00.000Z");
const events = [];

const members = {
  user: { memberId: "m_user", role: "user", mode: "human", provider: null, model: null, identitySource: "configured" },
  router: { memberId: "m_router", role: "router", mode: "local_model", provider: "ollama", model: "qwen2.5:0.5b", identitySource: "configured" },
  researcher: { memberId: "m_researcher", role: "researcher", mode: "api", provider: "anthropic", model: "claude-sonnet-5-5", identitySource: "provider_reported" },
  builder: { memberId: "m_builder", role: "builder", mode: "cli", provider: "codex-cli", model: null, identitySource: "configured" },
  reviewer: { memberId: "m_reviewer", role: "reviewer", mode: "api", provider: "anthropic", model: "claude-opus-5-5", identitySource: "provider_reported" },
  system: { memberId: null, role: "system", mode: "system", provider: null, model: null, identitySource: "configured" },
};

function emit(who, type, payload, ids = {}, stepMs = 400) {
  seq += 1;
  clock += stepMs;
  const e = {
    schemaVersion: 1,
    eventId: `evt_${String(seq).padStart(4, "0")}`,
    seq,
    roomId,
    ...(ids.runId ? { runId: ids.runId } : {}),
    ...(ids.taskId ? { taskId: ids.taskId } : {}),
    type,
    timestamp: new Date(clock).toISOString(),
    provenance: members[who],
    payload,
  };
  events.push(e);
  return e;
}

const caps = (tools, cancel, resume, streaming, usage) => ({ tools, cancel, resume, streaming, usage });
const src = (name, url, snippet) => ({ name, url, domain: new URL(url).hostname, snippet });
const unknownUsage = { inputTokens: null, outputTokens: null, costUsd: null, source: "unknown" };

// --- room and members -------------------------------------------------------
emit("system", "room.created", {
  goal: "Audit the handbook for facts that have gone out of date and open a pull request with cited corrections.",
  acceptanceCriteria: [
    "Every corrected fact cites at least two independent sources.",
    "Only lines that contain a stale fact are changed.",
    "The reviewer confirms the evidence for each change.",
  ],
  constraints: ["Search the web only through Linkup.", "Never push to the handbook's main branch."],
  limits: { maxRuns: 12, maxMinutes: 15, maxUsd: 2 },
  workflow: "shelf-life",
  driver: "harness",
  roomVersion: 1,
  synthetic: true,
});
emit("system", "member.joined", { memberId: "m_user", displayName: "Demo user", role: "user", mode: "human", provider: null, model: null, capabilities: caps(false, false, false, "none", "unknown") });
emit("system", "member.joined", { memberId: "m_router", displayName: "Router (0.5B)", role: "router", mode: "local_model", provider: "ollama", model: "qwen2.5:0.5b", capabilities: caps(false, true, false, "none", "exact") });
emit("system", "member.joined", { memberId: "m_researcher", displayName: "Researcher", role: "researcher", mode: "api", provider: "anthropic", model: "claude-sonnet-5-5", capabilities: caps(true, true, false, "token", "exact") });
emit("system", "member.joined", { memberId: "m_builder", displayName: "Builder", role: "builder", mode: "cli", provider: "codex-cli", model: null, capabilities: caps(true, true, false, "chunk", "unknown") });
emit("system", "member.joined", { memberId: "m_reviewer", displayName: "Reviewer", role: "reviewer", mode: "api", provider: "anthropic", model: "claude-opus-5-5", capabilities: caps(true, true, false, "token", "exact") });

// --- goal, first route, tasks ----------------------------------------------
const goal = emit("user", "message.posted", {
  messageId: "msg_001", author: "m_user", recipients: [], kind: "user",
  content: "Check handbook/pricing.md for anything out of date and open a PR with the fixes. Cite your sources.",
}, {}, 1200);
emit("router", "route.decided", {
  triggerEventId: goal.eventId, deliverTo: ["m_researcher"], wake: ["m_researcher"],
  reasonCode: "workflow_start", escalate: false, source: "rules", model: null, latencyMs: 1, roomVersion: 1,
});
emit("system", "task.created", { title: "Extract and verify the claims in pricing.md", owner: "m_researcher", dependencies: [], inputs: { doc: "handbook/pricing.md" }, deliverables: ["A verdict with sources for every claim"], acceptance: ["Each stale verdict passes the independent_sources check"], status: "ready", version: 1 }, { taskId: "task_verify" });
emit("system", "task.created", { title: "Rewrite the stale lines and open a pull request", owner: "m_builder", dependencies: ["task_verify"], inputs: { doc: "handbook/pricing.md" }, deliverables: ["A pull request"], acceptance: ["The diff passes the patch_scope check"], status: "pending", version: 1 }, { taskId: "task_patch" });
emit("system", "task.created", { title: "Review the evidence and the diff", owner: "m_reviewer", dependencies: ["task_patch"], inputs: {}, deliverables: ["A review result tied to a commit"], acceptance: ["Every change is supported by its cited sources"], status: "pending", version: 1 }, { taskId: "task_review" });

// --- researcher run ---------------------------------------------------------
const r1 = { runId: "run_001", taskId: "task_verify" };
emit("researcher", "task.claimed", { claimId: "claim_task_001", memberId: "m_researcher", taskVersion: 1, leaseUntil: new Date(clock + 600000).toISOString() }, { taskId: "task_verify" });
emit("system", "task.updated", { status: "running", version: 2 }, { taskId: "task_verify" });
emit("researcher", "run.started", { memberId: "m_researcher", provider: "anthropic", model: "claude-sonnet-5-5", attempt: 1, triggerEventId: goal.eventId, roomVersion: 1 }, r1);
emit("researcher", "tool.called", { toolCallId: "tc_001", name: "handbook_read", args: { doc: "handbook/pricing.md" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_001", name: "handbook_read", status: "ok", summary: "41 lines", durationMs: 12 }, r1, 60);
emit("researcher", "shelflife.claim.extracted", { claimId: "c1", doc: "handbook/pricing.md", lineStart: 12, lineEnd: 12, quote: "The free tier includes 500 build minutes per month.", statement: "Acme Cloud's free tier includes 500 build minutes per month.", category: "limit" }, r1, 2500);
emit("researcher", "shelflife.claim.extracted", { claimId: "c2", doc: "handbook/pricing.md", lineStart: 18, lineEnd: 18, quote: "Support replies within 2 business days.", statement: "Acme Cloud support replies within 2 business days.", category: "policy" }, r1, 30);
emit("researcher", "shelflife.claim.extracted", { claimId: "c3", doc: "handbook/pricing.md", lineStart: 27, lineEnd: 27, quote: "The Team plan costs $20 per seat.", statement: "Acme Cloud's Team plan costs $20 per seat per month.", category: "price" }, r1, 30);
emit("researcher", "run.output", { delta: "Found 3 checkable claims. Checking each one with Linkup.", channel: "progress" }, r1);

// claim c1: first search fails the independence check, the retry passes
emit("researcher", "tool.called", { toolCallId: "tc_002", name: "linkup_search", args: { claimId: "c1", query: "Acme Cloud free tier build minutes per month" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_002", name: "linkup_search", status: "ok", summary: "2 sources", durationMs: 3100 }, r1, 3100);
const c1a = [
  src("Acme Cloud pricing", "https://docs.acme.example/pricing", "Free: 300 build minutes each month."),
  src("Acme Cloud changelog", "https://docs.acme.example/changelog/2026-06", "From 1 June the free tier moves from 500 to 300 build minutes."),
];
emit("researcher", "shelflife.search.completed", { claimId: "c1", attempt: 1, query: "Acme Cloud free tier build minutes per month", provider: "linkup", depth: "standard", answer: "The free tier now includes 300 build minutes per month.", sources: c1a, durationMs: 3100 }, r1, 20);
emit("researcher", "shelflife.verdict.proposed", { claimId: "c1", attempt: 1, verdict: "stale", currentValue: "300 build minutes per month", correction: "The free tier includes 300 build minutes per month.", rationale: "The pricing page and the changelog both give 300.", sources: c1a }, r1, 2200);
emit("system", "shelflife.check.result", { claimId: "c1", attempt: 1, check: "independent_sources", passed: false, detail: "Both sources are from docs.acme.example." }, r1, 5);
emit("researcher", "run.output", { delta: "Both sources for c1 come from the same site. Searching again for an independent one.", channel: "progress" }, r1);
emit("researcher", "tool.called", { toolCallId: "tc_003", name: "linkup_search", args: { claimId: "c1", query: "Acme Cloud cuts free build minutes 500 to 300 news" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_003", name: "linkup_search", status: "ok", summary: "3 sources", durationMs: 2800 }, r1, 2800);
const c1b = [c1a[0], src("DevTools Weekly", "https://news.devtools.example/acme-free-tier", "Acme Cloud has reduced its free allowance to 300 build minutes a month.")];
emit("researcher", "shelflife.search.completed", { claimId: "c1", attempt: 2, query: "Acme Cloud cuts free build minutes 500 to 300 news", provider: "linkup", depth: "standard", answer: "Independent coverage confirms the cut to 300 minutes.", sources: c1b, durationMs: 2800 }, r1, 20);
emit("researcher", "shelflife.verdict.proposed", { claimId: "c1", attempt: 2, verdict: "stale", currentValue: "300 build minutes per month", correction: "The free tier includes 300 build minutes per month.", rationale: "The vendor's pricing page and independent news coverage agree.", sources: c1b }, r1, 1900);
const c1check = emit("system", "shelflife.check.result", { claimId: "c1", attempt: 2, check: "independent_sources", passed: true, detail: "2 sources from 2 domains." }, r1, 5);
emit("system", "shelflife.check.result", { claimId: "c1", attempt: 2, check: "correction_supported", passed: true, detail: "\"300\" appears in both snippets." }, r1, 5);
emit("researcher", "shelflife.verdict.final", { claimId: "c1", verdict: "stale", currentValue: "300 build minutes per month", correction: "The free tier includes 300 build minutes per month.", sources: c1b, attempts: 2, escalated: false }, r1, 10);

// claim c2: still true
emit("researcher", "tool.called", { toolCallId: "tc_004", name: "linkup_search", args: { claimId: "c2", query: "Acme Cloud support response time business days" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_004", name: "linkup_search", status: "ok", summary: "2 sources", durationMs: 2600 }, r1, 2600);
const c2s = [src("Acme Cloud support policy", "https://docs.acme.example/support", "We reply within 2 business days on all plans."), src("Acme status and help", "https://help.acme-status.example/sla", "Standard support: first reply within two business days.")];
emit("researcher", "shelflife.search.completed", { claimId: "c2", attempt: 1, query: "Acme Cloud support response time business days", provider: "linkup", depth: "standard", answer: "Support still replies within 2 business days.", sources: c2s, durationMs: 2600 }, r1, 20);
emit("researcher", "shelflife.verdict.proposed", { claimId: "c2", attempt: 1, verdict: "fresh", currentValue: "2 business days", correction: null, rationale: "Both sources match the handbook.", sources: c2s }, r1, 1700);
emit("researcher", "shelflife.verdict.final", { claimId: "c2", verdict: "fresh", currentValue: "2 business days", correction: null, sources: c2s, attempts: 1, escalated: false }, r1, 10);

// claim c3: sources disagree twice, so it is escalated and left for a person
emit("researcher", "tool.called", { toolCallId: "tc_005", name: "linkup_search", args: { claimId: "c3", query: "Acme Cloud Team plan price per seat" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_005", name: "linkup_search", status: "ok", summary: "2 sources", durationMs: 2900 }, r1, 2900);
const c3a = [src("Acme Cloud pricing", "https://docs.acme.example/pricing", "Team: $24 per seat, billed monthly."), src("SaaS price tracker", "https://prices.saas-tracker.example/acme", "Acme Cloud Team: $20/seat.")];
emit("researcher", "shelflife.search.completed", { claimId: "c3", attempt: 1, query: "Acme Cloud Team plan price per seat", provider: "linkup", depth: "standard", answer: "Sources disagree: $24 on the vendor page, $20 on a tracker.", sources: c3a, durationMs: 2900 }, r1, 20);
emit("researcher", "shelflife.verdict.proposed", { claimId: "c3", attempt: 1, verdict: "unsure", currentValue: null, correction: null, rationale: "The two sources give different prices.", sources: c3a }, r1, 1800);
emit("researcher", "tool.called", { toolCallId: "tc_006", name: "linkup_search", args: { claimId: "c3", query: "Acme Cloud Team plan price change 2026" } }, r1);
emit("researcher", "tool.result", { toolCallId: "tc_006", name: "linkup_search", status: "timeout", summary: "No response within 20 s", durationMs: 20000 }, r1, 20000);
emit("researcher", "shelflife.search.completed", { claimId: "c3", attempt: 2, query: "Acme Cloud Team plan price change 2026", provider: "linkup", depth: "standard", answer: null, sources: [], durationMs: 20000 }, r1, 20);
emit("researcher", "shelflife.verdict.final", { claimId: "c3", verdict: "unsure", currentValue: null, correction: null, sources: c3a, attempts: 2, escalated: true }, r1, 10);
emit("researcher", "run.completed", { stopReason: "end_turn", usage: { inputTokens: 18432, outputTokens: 2210, costUsd: 0.059, source: "provider" }, durationMs: 48200 }, r1, 300);

const handoff = emit("researcher", "message.posted", {
  messageId: "msg_002", author: "m_researcher", recipients: ["m_builder"], kind: "agent", replyTo: "msg_001",
  content: "c1 is stale: the free tier is now 300 build minutes (2 independent sources). c2 is still correct. c3 is unsure: sources disagree on the Team price, so leave line 27 alone and flag it for a person.",
}, { taskId: "task_verify" });
emit("researcher", "artifact.registered", { artifactId: "art_verdicts", kind: "source_list", location: "data/rooms/room_sample_shelflife/verdicts.json", version: null, evidence: [{ kind: "check", ref: c1check.eventId, summary: "c1 has 2 sources from 2 domains", passed: true }] }, { taskId: "task_verify" });
emit("system", "task.done", { verifiedBy: "check", evidence: [{ kind: "check", ref: c1check.eventId, summary: "Every stale verdict passed independent_sources", passed: true }], version: 3 }, { taskId: "task_verify" });

// --- builder run (official CLI: usage is unknown, so it is null) -------------
emit("router", "route.decided", { triggerEventId: handoff.eventId, deliverTo: ["m_builder", "m_reviewer"], wake: ["m_builder"], reasonCode: "handoff_ready", escalate: false, source: "local_model", model: "qwen2.5:0.5b", latencyMs: 85, roomVersion: 1 });
const r2 = { runId: "run_002", taskId: "task_patch" };
emit("builder", "task.claimed", { claimId: "claim_task_002", memberId: "m_builder", taskVersion: 1, leaseUntil: new Date(clock + 600000).toISOString() }, { taskId: "task_patch" });
emit("system", "task.updated", { status: "running", version: 2 }, { taskId: "task_patch" });
emit("builder", "run.started", { memberId: "m_builder", provider: "codex-cli", model: null, attempt: 1, triggerEventId: handoff.eventId, roomVersion: 1 }, r2);
emit("builder", "run.output", { delta: "Editing handbook/pricing.md line 12, then opening a pull request.", channel: "progress" }, r2, 4000);
emit("builder", "shelflife.patch.proposed", { doc: "handbook/pricing.md", claimIds: ["c1"], diff: "--- a/handbook/pricing.md\n+++ b/handbook/pricing.md\n@@ -12 +12 @@\n-The free tier includes 500 build minutes per month.\n+The free tier includes 300 build minutes per month.\n" }, r2, 6000);
emit("system", "shelflife.check.result", { claimId: "c1", attempt: 1, check: "patch_scope", passed: true, detail: "The diff changes line 12 only." }, r2, 5);
emit("builder", "tool.called", { toolCallId: "tc_007", name: "open_pull_request", args: { repo: "acme/handbook", branch: "shelf-life/pricing-2026-11-14" } }, r2);
emit("builder", "tool.result", { toolCallId: "tc_007", name: "open_pull_request", status: "ok", summary: "PR #7 opened", durationMs: 1900 }, r2, 1900);
const pr = emit("builder", "shelflife.pr.opened", { repo: "acme/handbook", number: 7, url: "https://git.acme.example/acme/handbook/pull/7", branch: "shelf-life/pricing-2026-11-14", commit: "3f9c2ab", claimIds: ["c1"] }, r2, 20);
emit("builder", "artifact.registered", { artifactId: "art_pr_7", kind: "pull_request", location: "https://git.acme.example/acme/handbook/pull/7", version: "3f9c2ab", evidence: [] }, { taskId: "task_patch" });
emit("builder", "run.completed", { stopReason: null, usage: unknownUsage, durationMs: 21400 }, r2, 300);
emit("builder", "task.review", { requestedBy: "m_builder", artifactIds: ["art_pr_7"], version: 3 }, { taskId: "task_patch" });

// --- reviewer sends it back once --------------------------------------------
emit("router", "route.decided", { triggerEventId: pr.eventId, deliverTo: ["m_reviewer"], wake: ["m_reviewer"], reasonCode: "review_required", escalate: false, source: "local_model", model: "qwen2.5:0.5b", latencyMs: 92, roomVersion: 1 });
const r3 = { runId: "run_003", taskId: "task_review" };
emit("reviewer", "run.started", { memberId: "m_reviewer", provider: "anthropic", model: "claude-opus-5-5", attempt: 1, triggerEventId: pr.eventId, roomVersion: 1 }, r3);
emit("reviewer", "shelflife.review.result", { commit: "3f9c2ab", passed: false, findings: [{ claimId: "c1", issue: "The pull request description cites only the vendor page. Add the independent source." }] }, r3, 9000);
const sendBack = emit("reviewer", "message.posted", { messageId: "msg_003", author: "m_reviewer", recipients: ["m_builder"], kind: "agent", replyTo: "msg_002", content: "The change to line 12 is right, but the PR description lists one source. Add the DevTools Weekly link so both sources are on the record." }, { taskId: "task_review" });
emit("reviewer", "run.completed", { stopReason: "end_turn", usage: { inputTokens: 6120, outputTokens: 540, costUsd: 0.035, source: "provider" }, durationMs: 9800 }, r3, 300);
emit("system", "task.updated", { status: "running", version: 4, note: "Sent back by the reviewer" }, { taskId: "task_patch" });

// --- targeted revision, then acceptance --------------------------------------
emit("router", "route.decided", { triggerEventId: sendBack.eventId, deliverTo: ["m_builder"], wake: ["m_builder"], reasonCode: "revision_requested", escalate: false, source: "rules", model: null, latencyMs: 1, roomVersion: 1 });
const r4 = { runId: "run_004", taskId: "task_patch" };
emit("builder", "run.started", { memberId: "m_builder", provider: "codex-cli", model: null, attempt: 2, triggerEventId: sendBack.eventId, roomVersion: 1 }, r4);
const upd = emit("builder", "shelflife.pr.updated", { repo: "acme/handbook", number: 7, url: "https://git.acme.example/acme/handbook/pull/7", commit: "3f9c2ab", note: "Description now lists both sources for c1." }, r4, 7000);
emit("builder", "run.completed", { stopReason: null, usage: unknownUsage, durationMs: 8300 }, r4, 300);
emit("router", "route.decided", { triggerEventId: upd.eventId, deliverTo: ["m_reviewer"], wake: ["m_reviewer"], reasonCode: "review_required", escalate: false, source: "local_model", model: "qwen2.5:0.5b", latencyMs: 88, roomVersion: 1 });
const r5 = { runId: "run_005", taskId: "task_review" };
emit("reviewer", "run.started", { memberId: "m_reviewer", provider: "anthropic", model: "claude-opus-5-5", attempt: 2, triggerEventId: upd.eventId, roomVersion: 1 }, r5);
const pass = emit("reviewer", "shelflife.review.result", { commit: "3f9c2ab", passed: true, findings: [] }, r5, 7000);
emit("reviewer", "run.completed", { stopReason: "end_turn", usage: { inputTokens: 6480, outputTokens: 310, costUsd: 0.032, source: "provider" }, durationMs: 7600 }, r5, 300);
emit("system", "task.done", { verifiedBy: "m_reviewer", evidence: [{ kind: "artifact", ref: "art_pr_7", summary: "PR #7 at commit 3f9c2ab", passed: true }, { kind: "check", ref: pass.eventId, summary: "Reviewer passed the evidence for c1", passed: true }], version: 5 }, { taskId: "task_patch" });
emit("system", "task.done", { verifiedBy: "m_reviewer", evidence: [{ kind: "check", ref: pass.eventId, summary: "Review tied to commit 3f9c2ab", passed: true }], version: 2 }, { taskId: "task_review" });
emit("system", "message.posted", { messageId: "msg_004", author: "m_reviewer", recipients: [], kind: "system", content: "Done. 3 claims checked: 1 stale and fixed in PR #7, 1 still correct, 1 unsure (Team plan price) left for a person." });
emit("system", "room.closed", { status: "completed", summary: "1 stale, 1 fresh, 1 unsure; 1 pull request; 1 revision requested and resolved." });

const out = join(here, "shelf-life-room.sample.jsonl");
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
console.log(`wrote ${events.length} events to ${out}`);
