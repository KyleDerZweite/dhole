import { createHash } from 'node:crypto';
import { SkillManifestSchema, type SkillManifest } from './types.js';

export interface ParsedSkill {
  manifest: SkillManifest;
  body: string;
  contentHash: string;
}

export interface SkillParseOptions {
  directory?: string;
  references?: readonly string[];
}

const knownKeys = new Set(['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata', 'references']);

/** Parse the small YAML subset used by portable Agent Skills frontmatter. */
export function parseSkillMarkdown(markdown: string, options: SkillParseOptions | string = {}): ParsedSkill {
  if (typeof markdown !== 'string' || markdown.length === 0 || markdown.length > 500_000) throw new Error('SKILL.md must contain 1 to 500,000 characters');
  const parseOptions: SkillParseOptions = typeof options === 'string' ? { directory: options } : options;
  const lines = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw new Error('SKILL.md must start with YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed');
  const values = new Map<string, unknown>();
  let pending: { key: string; mode: '>' | '|' | 'metadata' } | undefined;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (pending && (/^\s+/.test(line) || line.trim() === '')) {
      if (pending.mode === 'metadata') {
        if (!line.trim()) continue;
        const metadataLine = /^\s{1,}([A-Za-z][A-Za-z0-9_.-]{0,63})\s*:\s*(.*)$/.exec(line);
        if (!metadataLine) throw new Error(`Invalid metadata line ${index + 1}`);
        const metadata = (values.get(pending.key) as Record<string, string> | undefined) ?? {};
        metadata[metadataLine[1]!] = stripQuotes(metadataLine[2]!.trim()).slice(0, 500);
        values.set(pending.key, metadata);
        continue;
      }
      const previous = String(values.get(pending.key) ?? '');
      values.set(pending.key, `${previous}${previous ? (pending.mode === '>' ? ' ' : '\n') : ''}${line.trim()}`);
      continue;
    }
    pending = undefined;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(?: {0,3})([A-Za-z][A-Za-z0-9_-]{0,63})\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid frontmatter line ${index + 1}`);
    const key = match[1]!.toLowerCase();
    if (!knownKeys.has(key)) throw new Error(`Unsupported frontmatter key: ${key}`);
    if (values.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
    const raw = match[2]!.trim();
    if (raw === '>' || raw === '|') {
      pending = { key, mode: raw };
      values.set(key, '');
    } else if (key === 'metadata' && raw === '') {
      pending = { key, mode: 'metadata' };
      values.set(key, {});
    } else {
      values.set(key, parseValue(raw, key));
    }
  }
  const rawManifest: Record<string, unknown> = {
    name: values.get('name'),
    description: values.get('description'),
  };
  for (const key of ['license', 'compatibility', 'allowed-tools', 'metadata', 'references']) {
    if (values.has(key)) rawManifest[key === 'allowed-tools' ? 'allowedTools' : key] = values.get(key);
  }
  if (parseOptions.references) {
    const existing = Array.isArray(rawManifest.references) ? rawManifest.references : [];
    rawManifest.references = [...existing, ...parseOptions.references];
  }
  const manifest = normalizeManifest(SkillManifestSchema.parse(rawManifest));
  if (parseOptions.directory) validateSkillDirectory(parseOptions.directory, manifest.name);
  if (manifest.references) for (const reference of manifest.references) validateSkillReference(reference);
  const body = lines.slice(end + 1).join('\n').trim();
  return { manifest, body, contentHash: digest({ manifest, body }) };
}

export const validateSkillMarkdown = parseSkillMarkdown;

export function validateSkillPackage(input: { markdown: string; directory?: string; references?: readonly string[] }): ParsedSkill {
  return parseSkillMarkdown(input.markdown, {
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    ...(input.references === undefined ? {} : { references: input.references }),
  });
}

export function validateSkillDirectory(directory: string, skillName?: string): string {
  if (!directory || directory.length > 1_024 || directory.includes('\\') || directory.includes('\0') || directory.startsWith('/')) throw new Error('Skill directory must be a bounded relative path');
  const parts = directory.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Skill directory traversal is not allowed');
  const basename = parts.at(-1)!;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename) || basename.length > 64) throw new Error('Skill directory name is invalid');
  if (skillName && basename !== skillName) throw new Error('Skill name must match its directory name');
  return directory;
}

export function validateSkillReference(reference: string): string {
  if (!reference || reference.length > 1_024 || reference.includes('\\') || reference.includes('\0') || reference.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) throw new Error('Skill references must be bounded relative paths');
  const parts = reference.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Skill reference traversal is not allowed');
  return reference;
}

function parseValue(raw: string, key: string): unknown {
  const value = stripQuotes(raw);
  if (key === 'allowed-tools' || key === 'references') {
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      return inner ? inner.split(',').map((item) => stripQuotes(item.trim())).filter(Boolean) : [];
    }
    return value ? value.split(',').map((item) => stripQuotes(item.trim())).filter(Boolean) : [];
  }
  if (key === 'metadata') {
    if (!value.startsWith('{') || !value.endsWith('}')) throw new Error('metadata must be a JSON object or omitted');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('metadata must be valid JSON');
    }
    return parsed;
  }
  return value;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function normalizeManifest(manifest: SkillManifest): SkillManifest {
  return {
    name: manifest.name,
    description: manifest.description,
    ...(manifest.stableKey ? { stableKey: manifest.stableKey } : {}),
    ...(manifest.contentHash ? { contentHash: manifest.contentHash } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.compatibility ? { compatibility: manifest.compatibility } : {}),
    ...(manifest.allowedTools?.length ? { allowedTools: [...new Set(manifest.allowedTools)] } : {}),
    ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
    ...(manifest.references?.length ? { references: [...new Set(manifest.references)] } : {}),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
