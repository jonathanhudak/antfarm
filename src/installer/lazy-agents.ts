/**
 * Lazy agent registration: agents are added to openclaw.json only when a
 * workflow run starts, and removed when the last run for that workflow ends.
 *
 * This prevents resource exhaustion (file descriptors, memory) on constrained
 * machines where 20+ permanently registered agents cause `spawn EBADF` errors.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readOpenClawConfig, writeOpenClawConfig } from "./openclaw-config.js";
import { addSubagentAllowlist, removeSubagentAllowlist } from "./subagent-allowlist.js";
import type { AgentRole } from "./types.js";
import { getDb } from "../db.js";

// ── Tool policies (duplicated from install.ts to avoid circular deps) ──

const ALWAYS_DENY = ["gateway", "cron", "message", "nodes", "canvas", "sessions_spawn", "sessions_send"];

const ROLE_TOOL_POLICIES: Record<AgentRole, { profile?: string; alsoAllow?: string[]; deny: string[] }> = {
  analysis: {
    profile: "coding",
    deny: [...ALWAYS_DENY, "write", "edit", "apply_patch", "image", "tts", "group:ui"],
  },
  coding: {
    profile: "coding",
    deny: [...ALWAYS_DENY, "image", "tts", "group:ui"],
  },
  verification: {
    profile: "coding",
    deny: [...ALWAYS_DENY, "write", "edit", "apply_patch", "image", "tts", "group:ui"],
  },
  testing: {
    profile: "coding",
    alsoAllow: ["browser", "web_search", "web_fetch"],
    deny: [...ALWAYS_DENY, "write", "edit", "apply_patch", "image", "tts"],
  },
  pr: {
    profile: "coding",
    deny: [...ALWAYS_DENY, "write", "edit", "apply_patch", "image", "tts", "group:ui"],
  },
  scanning: {
    profile: "coding",
    alsoAllow: ["web_search", "web_fetch"],
    deny: [...ALWAYS_DENY, "write", "edit", "apply_patch", "image", "tts", "group:ui"],
  },
  compound: {
    profile: "coding",
    deny: [...ALWAYS_DENY, "image", "tts", "group:ui"],
  },
};

const SUBAGENT_POLICY = { allowAgents: [] as string[] };

interface SavedAgentConfig {
  id: string;
  name?: string;
  workspaceDir: string;
  agentDir: string;
  role: AgentRole;
}

function buildToolsConfig(role: AgentRole): Record<string, unknown> {
  const policy = ROLE_TOOL_POLICIES[role];
  const tools: Record<string, unknown> = {};
  if (policy.profile) tools.profile = policy.profile;
  if (policy.alsoAllow?.length) tools.alsoAllow = policy.alsoAllow;
  tools.deny = policy.deny;
  return tools;
}

function ensureAgentList(config: { agents?: { list?: Array<Record<string, unknown>> } }) {
  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];
  return config.agents.list;
}

/**
 * Register workflow agents in openclaw.json. Called at `workflow run` time.
 * No-ops if agents are already registered (another run is active).
 */
export async function registerWorkflowAgents(workflowId: string, workflowDir: string): Promise<void> {
  const configFile = path.join(workflowDir, "agent-configs.json");

  let agentConfigs: SavedAgentConfig[];
  try {
    const raw = await fs.readFile(configFile, "utf-8");
    agentConfigs = JSON.parse(raw);
  } catch {
    // No agent-configs.json means this was installed before lazy agents.
    // Fall back silently — agents should already be in the config.
    return;
  }

  const { path: configPath, config } = await readOpenClawConfig();
  const list = ensureAgentList(config);

  // Check if agents are already registered
  const existingIds = new Set(list.map((e) => e.id as string));
  const newAgents = agentConfigs.filter((a) => !existingIds.has(a.id));

  if (newAgents.length === 0) return; // Already registered

  // Register agents
  const agentIds: string[] = [];
  for (const agent of agentConfigs) {
    agentIds.push(agent.id);
    if (existingIds.has(agent.id)) continue;
    list.push({
      id: agent.id,
      name: agent.name ?? agent.id,
      workspace: agent.workspaceDir,
      agentDir: agent.agentDir,
      tools: buildToolsConfig(agent.role),
      subagents: SUBAGENT_POLICY,
    });
  }

  addSubagentAllowlist(config, agentIds);
  await writeOpenClawConfig(configPath, config);
}

/**
 * Unregister workflow agents from openclaw.json when no more active runs exist.
 * Called when a run completes or fails.
 */
export async function unregisterWorkflowAgentsIfIdle(workflowId: string): Promise<void> {
  // Check if there are still active runs
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'"
    ).get(workflowId) as { cnt: number };
    if (row.cnt > 0) return; // Other runs still active
  } catch {
    return; // DB not available, skip cleanup
  }

  const { path: configPath, config } = await readOpenClawConfig();
  const list = Array.isArray(config.agents?.list) ? config.agents!.list! : [];

  const prefix = `${workflowId}/`;
  const removedAgents = list.filter((e) => {
    const id = typeof e.id === "string" ? e.id : "";
    return id.startsWith(prefix);
  });

  if (removedAgents.length === 0) return;

  const keptAgents = list.filter((e) => !removedAgents.includes(e));
  config.agents!.list = keptAgents;

  removeSubagentAllowlist(
    config,
    removedAgents.map((e) => e.id as string).filter(Boolean),
  );

  await writeOpenClawConfig(configPath, config);
}
