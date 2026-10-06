// util/names.ts — duplicate / similar-name detection for candidate intake.
// A name is "similar" when it shares the last name (case-insensitive) AND the
// first initial with an existing record. Warnings never block anything; they
// only produce descriptors for the admin queue / submit response.

export interface NameWarning {
  type: 'exact' | 'similar';
  kind: 'user' | 'candidate';
  name: string; // the existing record's display name
}

export interface NamedRecord {
  name: string;
  kind: 'user' | 'candidate';
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function nameParts(name: string): { first: string; last: string } {
  const tokens = norm(name).split(' ').filter(Boolean);
  if (tokens.length === 0) return { first: '', last: '' };
  if (tokens.length === 1) return { first: tokens[0], last: '' };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

/** Compare a name against existing records in the same company. */
export function findNameWarnings(name: string, existing: NamedRecord[]): NameWarning[] {
  const target = norm(name);
  if (!target) return [];
  const tp = nameParts(target);
  const warnings: NameWarning[] = [];
  for (const e of existing) {
    const en = norm(e.name);
    if (!en || !e.name.trim()) continue;
    if (en === target) {
      warnings.push({ type: 'exact', kind: e.kind, name: e.name.trim() });
      continue;
    }
    const ep = nameParts(en);
    if (
      tp.first && tp.last && ep.first && ep.last &&
      tp.last === ep.last && tp.first[0] === ep.first[0]
    ) {
      warnings.push({ type: 'similar', kind: e.kind, name: e.name.trim() });
    }
  }
  return warnings;
}
