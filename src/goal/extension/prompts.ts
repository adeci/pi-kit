// Adapted from OMP 18.4.10; see ../OMP-LICENSE.
import { readFileSync } from "node:fs";
const load = (name: string) =>
  readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
export const active = load("active");
export const continuation = load("continuation");
export const budgetLimit = load("budgetLimit");
export const guided = load("guided");
export const escapeXmlText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export const render = (template: string, values: Record<string, string>) =>
  template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key: string) => values[key] ?? "",
  );
