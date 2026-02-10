import fs from "node:fs";
import path from "node:path";

/**
 * Load relevant learnings from docs/learnings/ based on keyword matching.
 * Returns formatted text to inject into agent context.
 */
export function loadRelevantLearnings(repoPath: string, taskDescription: string, tags?: string[]): string {
  const learningsDir = path.join(repoPath, "docs", "learnings");
  if (!fs.existsSync(learningsDir)) return "";

  const files = fs.readdirSync(learningsDir).filter(f => f.endsWith(".md"));
  if (files.length === 0) return "";

  const taskWords = new Set(
    taskDescription.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  );
  const tagSet = new Set((tags ?? []).map(t => t.toLowerCase()));

  type ScoredLearning = { file: string; content: string; score: number };
  const scored: ScoredLearning[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(learningsDir, file), "utf-8");

    // Parse YAML frontmatter tags
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const fileTags: string[] = [];
    if (frontmatterMatch) {
      const tagLine = frontmatterMatch[1].match(/tags:\s*\[([^\]]*)\]/);
      if (tagLine) {
        fileTags.push(...tagLine[1].split(",").map(t => t.trim().toLowerCase()));
      }
    }

    // Score by tag overlap + keyword overlap
    let score = 0;
    for (const tag of fileTags) {
      if (tagSet.has(tag)) score += 3;
      if (taskWords.has(tag)) score += 2;
    }

    const contentLower = content.toLowerCase();
    for (const word of taskWords) {
      if (contentLower.includes(word)) score += 1;
    }

    if (score > 0) {
      scored.push({ file, content, score });
    }
  }

  if (scored.length === 0) return "";

  // Return top 5 most relevant
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const sections = top.map(s => `### ${s.file}\n${s.content}`);
  return `## Previous Learnings (from similar tasks)\n\n${sections.join("\n\n---\n\n")}`;
}
