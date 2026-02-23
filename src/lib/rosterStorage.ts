const ROSTER_STORAGE_KEY = 'tactiq_roster_ids_v1';

const normalizeId = (value: unknown): string => String(value || '').trim();
const keyOf = (value: string): string => normalizeId(value).toLowerCase();

const dedupeIds = (ids: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  ids.forEach((id) => {
    const normalized = normalizeId(id);
    const key = keyOf(normalized);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });
  return result;
};

export const getRosterIds = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ROSTER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeIds(parsed.map((entry) => normalizeId(entry)));
  } catch {
    return [];
  }
};

export const setRosterIds = (ids: string[]): void => {
  if (typeof window === 'undefined') return;
  const next = dedupeIds(Array.isArray(ids) ? ids : []);
  try {
    window.localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage write failures.
  }
};

export const addToRoster = (id: string): string[] => {
  const current = getRosterIds();
  const next = dedupeIds([...current, id]);
  setRosterIds(next);
  return next;
};

export const removeFromRoster = (id: string): string[] => {
  const targetKey = keyOf(id);
  const next = getRosterIds().filter((entry) => keyOf(entry) !== targetKey);
  setRosterIds(next);
  return next;
};

export const clearRoster = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ROSTER_STORAGE_KEY);
  } catch {
    // Ignore storage write failures.
  }
};

export { ROSTER_STORAGE_KEY };
