import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type VaultPaths,
  extractWikilinks,
  findWikiPages,
  fmtDate,
  normalizeAccents,
  parseFrontmatter,
  readJson,
  readText,
  slugify,
  writeJson,
} from "./utils.js";

/**
 * Metadata generation for the LLM Wiki.
 *
 * Rebuilds registry.json, backlinks.json, index.md, log.md, and lint-report.md
 * deterministically from the current state of raw/ and wiki/.
 */

export interface RegistryEntry {
  type: "source" | "entity" | "concept" | "synthesis" | "analysis";
  title: string;
  created: string;
  updated: string;
  [key: string]: unknown;
}

export interface Registry {
  version: string;
  last_updated: string;
  pages: Record<string, RegistryEntry>;
}

export interface Backlinks {
  [pageId: string]: string[];
}

export interface WikiEvent {
  timestamp: string;
  kind: string;
  [key: string]: unknown;
}

/** Rebuild the complete metadata layer. */
export function rebuildMetadata(paths: VaultPaths): void {
  mkdirSync(paths.meta, { recursive: true });

  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);

  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}

/** Build registry from wiki/ and raw/ state. */
export function buildRegistry(paths: VaultPaths): Registry {
  const pages: Record<string, RegistryEntry> = {};

  // Scan wiki pages
  for (const page of findWikiPages(paths.wiki)) {
    const { frontmatter } = parseFrontmatter(page.content);
    const type = String(frontmatter.type || "page") as RegistryEntry["type"];
    const title = String(frontmatter.title || page.relative.split("/").pop() || "Untitled");

    pages[page.relative] = {
      type,
      title,
      created: String(frontmatter.created || fmtDate()),
      updated: String(frontmatter.updated || frontmatter.created || fmtDate()),
      ...frontmatter,
    };
  }

  // Scan raw source packets
  if (existsSync(paths.rawSources)) {
    for (const entry of readdirSync(paths.rawSources)) {
      const manifestPath = join(paths.rawSources, entry, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = readJson<Record<string, unknown>>(manifestPath, {});
      const id = String(manifest.id || entry);
      const sourcePage = `sources/${id}`;

      if (!pages[sourcePage]) {
        pages[sourcePage] = {
          type: "source",
          title: String(manifest.title || id),
          created: String(manifest.captured || fmtDate()),
          updated: String(manifest.captured || fmtDate()),
          ...manifest,
        };
      }
    }
  }

  return {
    version: "1.0",
    last_updated: new Date().toISOString(),
    pages,
  };
}

/** Build a lookup map from wikilink text → page path (registry key).
 *  Stores page path under multiple derived forms of each candidate name
 *  (exact, lowercase, slugified, hyphen-slugified) for flexible resolution.
 */
export function buildWikilinkResolver(registry: Registry): Map<string, string> {
  const resolver = new Map<string, string>();

  for (const [pagePath, entry] of Object.entries(registry.pages)) {
    const folder = pagePath.includes("/") ? pagePath.split("/")[0] : "";
    const filename = pagePath.includes("/") ? pagePath.split("/").pop()! : pagePath;

    // Collect all text candidates that should resolve to this page
    const candidates: string[] = [pagePath, filename, entry.title || ""];

    // Aliases from frontmatter (handle both array and string forms)
    const rawAliases = entry.aliases;
    if (Array.isArray(rawAliases)) {
      for (const a of rawAliases) candidates.push(String(a));
    } else if (typeof rawAliases === "string") {
      try {
        const parsed = JSON.parse((rawAliases as string).replace(/'/g, '"'));
        if (Array.isArray(parsed)) for (const a of parsed) candidates.push(String(a).trim());
      } catch {
        // Try comma-separated
        const parts = (rawAliases as string).replace(/[\[\]]/g, "").split(",");
        for (const p of parts) candidates.push(p.trim());
      }
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "string" || !candidate.trim()) continue;
      const trimmed = candidate.trim();

      // Store all lookup-friendly forms
      const forms: string[] = [trimmed, trimmed.toLowerCase(), slugify(trimmed)];

      // Hyphen slug variant: accent-normalized then non-alnum → hyphen
      const hyphenForm = normalizeAccents(trimmed.toLowerCase())
        .replace(/[^a-z0-9\s-]/g, "-")
        .replace(/[\s-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
      if (hyphenForm) forms.push(hyphenForm);

      for (const form of forms) {
        if (!form) continue;
        resolver.set(form, pagePath);
        if (folder) resolver.set(`${folder}/${form}`, pagePath);
      }
    }
  }

  return resolver;
}

/** Resolve a wikilink text against the resolver, trying multiple strategies. */
export function resolveWikilink(resolver: Map<string, string>, link: string): string | undefined {
  if (!link) return undefined;

  const lower = link.toLowerCase();

  // Slug via slugify (normalizes French accents, strips remaining non-alnum)
  const slug = slugify(link);

  // Hyphen-slug: normalize accents, replace remaining non-alnum with hyphen,
  // collapse spaces and hyphens
  const hyphenForm = normalizeAccents(link.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, "-")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  const strategies: string[] = [link, lower, slug, hyphenForm];
  for (const s of strategies) {
    if (!s) continue;
    const result = resolver.get(s);
    if (result) return result;
  }
  return undefined;
}

/** Build backlinks map from all wiki pages. */
export function buildBacklinks(paths: VaultPaths, registry: Registry): Backlinks {
  const inbound: Backlinks = {};

  // Initialize all pages with empty arrays
  for (const id of Object.keys(registry.pages)) {
    inbound[id] = [];
  }

  // Build wikilink resolver
  const resolver = buildWikilinkResolver(registry);

  // Count inbound links
  for (const page of findWikiPages(paths.wiki)) {
    const links = extractWikilinks(page.content);
    for (const link of links) {
      const resolved = resolveWikilink(resolver, link);
      if (resolved && inbound[resolved] && !inbound[resolved].includes(page.relative)) {
        inbound[resolved].push(page.relative);
      }
    }
  }

  return inbound;
}

/** Build index markdown from registry. */
export function buildIndexMarkdown(registry: Registry): string {
  const byType: Record<string, Array<{ id: string; entry: RegistryEntry }>> = {};

  for (const [id, entry] of Object.entries(registry.pages)) {
    const t = entry.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push({ id, entry });
  }

  const sections: string[] = [];
  sections.push(
    "# Wiki Index\n\n> Auto-generated from meta/registry.json. Do not edit manually.\n",
  );

  for (const [type, items] of Object.entries(byType).sort()) {
    const label = `${type.charAt(0).toUpperCase() + type.slice(1)}s`;
    sections.push(`## ${label}\n`);
    for (const { id, entry } of items.sort((a, b) => a.id.localeCompare(b.id))) {
      sections.push(`- [[${id}]] — ${entry.title} *(created: ${entry.created})*`);
    }
    sections.push("");
  }

  sections.push(
    `---\n*Last updated: ${registry.last_updated}* | *Total pages: ${Object.keys(registry.pages).length}*`,
  );
  return `${sections.join("\n")}\n`;
}

/** Build log markdown from events.jsonl. */
export function buildLogMarkdown(paths: VaultPaths): string {
  const eventsPath = join(paths.meta, "events.jsonl");
  const events: WikiEvent[] = [];

  if (existsSync(eventsPath)) {
    const raw = readFileSync(eventsPath, "utf-8").trim();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as WikiEvent);
      } catch {
        // skip malformed
      }
    }
  }

  const lines: string[] = [];
  lines.push("# Activity Log\n\n> Auto-generated from meta/events.jsonl. Do not edit manually.\n");

  for (const ev of events) {
    const ts = ev.timestamp || "unknown";
    const kind = ev.kind || "event";
    const details = Object.entries(ev)
      .filter(([k]) => k !== "timestamp" && k !== "kind")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");

    lines.push(`## [${ts}] ${kind}`);
    if (details) lines.push(`- ${details}`);
    lines.push("");
  }

  if (events.length === 0) {
    lines.push("_No events recorded yet._\n");
  }

  return `${lines.join("\n")}\n`;
}

/** Append an event to events.jsonl. */
export function appendEvent(paths: VaultPaths, event: Omit<WikiEvent, "timestamp">): void {
  mkdirSync(paths.meta, { recursive: true });
  const eventsPath = join(paths.meta, "events.jsonl");
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  writeFileSync(eventsPath, `${line}\n`, { flag: "a", encoding: "utf-8" });
}

/** Quick lightweight metadata rebuild (backlinks + index + log only). */
export function rebuildMetadataLight(paths: VaultPaths): void {
  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);
  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}
