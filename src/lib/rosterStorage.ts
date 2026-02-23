const ROSTER_STORAGE_KEY = 'tactiq_roster_ids_v1';
const BASELINE_DRAFT_STORAGE_KEY = 'tactiq_baseline_drafts_v1';

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

const readBaselineDraftCache = (): Array<Record<string, unknown>> => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BASELINE_DRAFT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
};

const writeBaselineDraftCache = (rows: Array<Record<string, unknown>>): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BASELINE_DRAFT_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Ignore storage write failures.
  }
};

const updateBaselineDraftRosterState = (playerId: string, inRoster: boolean): void => {
  const targetKey = keyOf(playerId);
  if (!targetKey) return;
  const rows = readBaselineDraftCache();
  if (rows.length === 0) return;

  let didUpdate = false;
  const nextRows = rows.map((row) => {
    const rowId = keyOf(String(row.id || row.playerId || row.name || ''));
    if (!rowId || rowId !== targetKey) return row;
    didUpdate = true;
    return {
      ...row,
      inRoster,
      active: inRoster ? row.active : false,
    };
  });

  if (didUpdate) {
    writeBaselineDraftCache(nextRows);
  }
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
  updateBaselineDraftRosterState(id, true);
  return next;
};

export const removeFromRoster = (id: string): string[] => {
  const targetKey = keyOf(id);
  const next = getRosterIds().filter((entry) => keyOf(entry) !== targetKey);
  setRosterIds(next);
  updateBaselineDraftRosterState(id, false);
  return next;
};

export const removeFromRosterSession = (id: string, currentIds?: string[]): string[] => {
  const targetKey = keyOf(id);
  const source = Array.isArray(currentIds) ? dedupeIds(currentIds) : getRosterIds();
  const next = source.filter((entry) => keyOf(entry) !== targetKey);
  setRosterIds(next);
  updateBaselineDraftRosterState(id, false);
  return next;
};

export const setBaselineDraftCache = (rows: Array<Record<string, unknown>>): void => {
  writeBaselineDraftCache(Array.isArray(rows) ? rows : []);
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
