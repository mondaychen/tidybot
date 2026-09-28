/**
 * Instructions for the AI agent driving tidybot. This replaces the old hard-coded LLM prompt:
 * tidybot gathers context and applies decisions; the agent does the judging.
 * The text lives in guides/*.md at the package root (one level up from both src/ and dist/).
 */
import { readFileSync } from "node:fs";

export const GUIDE_TOPICS = ["overview", "organize", "summarize", "onboard"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const readGuide = (topic: GuideTopic): string =>
  readFileSync(new URL(`../guides/${topic}.md`, import.meta.url), "utf8");
