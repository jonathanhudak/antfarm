import fs from "node:fs/promises";
import path from "node:path";
import { fetchWorkflow } from "./workflow-fetch.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { provisionAgents } from "./agent-provision.js";
import { updateMainAgentGuidance } from "./main-agent-guidance.js";
import { installAntfarmSkill } from "./skill-install.js";
import type { AgentRole, WorkflowInstallResult } from "./types.js";

/**
 * Infer an agent's role from its id when not explicitly set in workflow YAML.
 * Matches common agent id patterns across all bundled workflows.
 */
function inferRole(agentId: string): AgentRole {
  const id = agentId.toLowerCase();
  if (id.includes("planner") || id.includes("prioritizer") || id.includes("reviewer")
      || id.includes("investigator") || id.includes("triager")) return "analysis";
  if (id.includes("verifier")) return "verification";
  if (id.includes("tester")) return "testing";
  if (id.includes("scanner")) return "scanning";
  if (id === "pr" || id.includes("/pr")) return "pr";
  if (id.includes("compound")) return "compound";
  // developer, fixer, setup → coding
  return "coding";
}

async function writeWorkflowMetadata(params: { workflowDir: string; workflowId: string; source: string }) {
  const content = { workflowId: params.workflowId, source: params.source, installedAt: new Date().toISOString() };
  await fs.writeFile(path.join(params.workflowDir, "metadata.json"), `${JSON.stringify(content, null, 2)}\n`, "utf-8");
}

export async function installWorkflow(params: { workflowId: string }): Promise<WorkflowInstallResult> {
  const { workflowDir, bundledSourceDir } = await fetchWorkflow(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const provisioned = await provisionAgents({ workflow, workflowDir, bundledSourceDir });

  // Build a role lookup: workflow agent id → role (explicit or inferred)
  const roleMap = new Map<string, AgentRole>();
  for (const agent of workflow.agents) {
    roleMap.set(agent.id, agent.role ?? inferRole(agent.id));
  }

  // Lazy agent registration: save agent configs to workflow metadata instead of
  // registering them in openclaw.json at install time. Agents are only added to
  // the config when a workflow run starts, and removed when it ends.
  // This prevents resource exhaustion (FD/memory) on constrained machines.
  const agentConfigs: Array<{ id: string; name?: string; workspaceDir: string; agentDir: string; role: AgentRole }> = [];
  for (const agent of provisioned) {
    const localId = agent.id.includes("/") ? agent.id.split("/").pop()! : agent.id;
    const role = roleMap.get(localId) ?? inferRole(localId);
    agentConfigs.push({ ...agent, role });
  }

  // Save agent configs for lazy registration during `workflow run`
  const agentConfigPath = path.join(workflowDir, "agent-configs.json");
  await fs.writeFile(agentConfigPath, JSON.stringify(agentConfigs, null, 2) + "\n", "utf-8");
  await updateMainAgentGuidance();
  await installAntfarmSkill();
  await writeWorkflowMetadata({ workflowDir, workflowId: workflow.id, source: `bundled:${params.workflowId}` });

  return { workflowId: workflow.id, workflowDir };
}
