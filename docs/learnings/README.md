# Learnings

This directory stores compound learnings from workflow runs. Each file captures what went well, what was harder than expected, and reusable patterns discovered during a workflow execution.

Files are automatically created by the **compound** step at the end of each workflow. Future runs load relevant learnings (matched by tags/keywords) into agent context to prevent repeated mistakes.

## Format

```yaml
---
date: YYYY-MM-DD
workflow: feature-dev|bug-fix|security-audit
task: "brief description"
tags: [specific, relevant, tags]
---

## What Went Well
...

## What Was Harder Than Expected
...

## Patterns & Anti-Patterns
...

## Reusable Solutions
...
```
