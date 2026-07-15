interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Sanctions Screening MCP — screen people, companies, vessels, and aircraft
 * against the US Consolidated Screening List (CSL): all 12 US government
 * restricted-party lists merged — OFAC SDN, Sectoral Sanctions (SSI), Chinese
 * Military-Industrial Complex (CMIC), BIS Entity List / Denied Persons /
 * Unverified / Military End User, State Department ITAR Debarred and
 * Nonproliferation Sanctions, and more.
 *
 * Queries the Pipeworx-hosted csl_entries table (Supabase), synced daily from
 * trade.gov's consolidated file by the csl-sync edge function — keyless for
 * callers, fuzzy-matched (trigram) with a relevance score. KYB/compliance
 * companion to companies-house + vies-eu.
 */


const LISTS: Record<string, string> = {
  SDN: 'Specially Designated Nationals (OFAC)',
  SSI: 'Sectoral Sanctions Identifications (OFAC)',
  CMIC: 'Non-SDN Chinese Military-Industrial Complex (OFAC)',
  'NS-MBS': 'Non-SDN Menu-Based Sanctions (OFAC)',
  CAP: 'Capta List (OFAC)',
  PLC: 'Palestinian Legislative Council (OFAC)',
  EL: 'Entity List (BIS)',
  DPL: 'Denied Persons List (BIS)',
  UVL: 'Unverified List (BIS)',
  MEU: 'Military End User List (BIS)',
  DTC: 'ITAR Debarred (State)',
  ISN: 'Nonproliferation Sanctions (State)',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'sanctions_screen',
    description:
      'Screen a person, company, vessel, or aircraft name against the US Consolidated Screening List — OFAC SDN sanctions, Sectoral Sanctions (SSI), Chinese Military-Industrial Complex (CMIC), BIS Entity List / Denied Persons / Military End User, State ITAR Debarred, and 5 more US restricted-party lists (~26k entries, synced daily). Fuzzy name matching with a 0-1 relevance score, matched aliases, programs, addresses, and which list each hit is on. Use for KYB / KYC / AML / export-control compliance checks. Returns an empty matches array when the name is clear.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person, company, vessel, or aircraft name to screen, e.g. "Rosneft" or "Huawei Technologies".' },
        list: { type: 'string', description: `Restrict to one list code: ${Object.keys(LISTS).join(' | ')}.` },
        type: { type: 'string', description: 'Restrict by entry type: Entity | Individual | Vessel | Aircraft.' },
        country: { type: 'string', description: '2-letter country code to filter matches by address/nationality, e.g. "CN", "RU", "IR".' },
        limit: { type: ['number', 'string'], description: 'Max matches (1-50, default 10).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sanctions_entry',
    description:
      'Get the full Consolidated Screening List record for one entry by its uid (from sanctions_screen results, e.g. "SDN:12345") or by OFAC entity number. Returns every field: all aliases, addresses, identity documents (passports, tax IDs, IMO numbers, crypto wallet addresses), sanction programs, license requirements, Federal Register notice, vessel details, and remarks.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Entry uid from sanctions_screen, e.g. "SDN:36318" or "EL:e123".' },
        entity_number: { type: 'string', description: 'OFAC/CSL entity number, e.g. "36318". Used if uid is not given.' },
      },
    },
  },
  {
    name: 'sanctions_lists',
    description:
      'List the 12 US restricted-party lists covered by the Consolidated Screening List with entry counts and data freshness (last sync time). Use to cite coverage in a compliance report: OFAC SDN/SSI/CMIC, BIS Entity List/DPL/UVL/MEU, State ITAR-Debarred/ISN, and more.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type SupabaseConfig = { url: string; key: string };

function supa(args: Record<string, unknown>): SupabaseConfig {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('Sanctions data store is not configured (missing Supabase injection).');
  return { url, key };
}

async function pg<T>(cfg: SupabaseConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Screening store: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

type Entry = Record<string, unknown>;

function shapeMatch(e: Entry): Record<string, unknown> {
  return {
    uid: e.uid,
    name: e.name,
    score: e.score,
    type: e.type ?? null,
    list: e.list_abbr,
    list_name: LISTS[String(e.list_abbr)] ?? e.source,
    programs: e.programs ?? [],
    alt_names: (e.alt_names as string[] | null)?.slice(0, 8) ?? [],
    country: e.country ?? null,
    addresses: (e.addresses as unknown[] | null)?.slice(0, 3) ?? [],
    title: e.title ?? null,
    remarks: typeof e.remarks === 'string' ? e.remarks.slice(0, 300) : null,
    source_list_url: e.source_list_url ?? null,
  };
}

async function screen(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (name.length < 2) {
    return { error: 'user_error', message: 'Pass a name of at least 2 characters, e.g. {"name": "Rosneft"}.' };
  }
  const lim = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const body = {
    q: name,
    list_filter: typeof args.list === 'string' && args.list.trim() ? args.list.trim() : null,
    type_filter: typeof args.type === 'string' && args.type.trim() ? args.type.trim() : null,
    country_filter: typeof args.country === 'string' && args.country.trim() ? args.country.trim() : null,
    lim,
  };
  const cfg = supa(args);
  const rows = await pg<Entry[]>(cfg, 'rpc/csl_screen', { method: 'POST', body: JSON.stringify(body) });
  return {
    query: name,
    matches_found: rows.length,
    clear: rows.length === 0,
    note: rows.length === 0
      ? 'No matches on any of the 12 US Consolidated Screening List lists. This is a name screen, not a full identity verification.'
      : 'Review matches — fuzzy name matching produces candidates, not confirmed identity matches. Use sanctions_entry(uid) for the full record.',
    matches: rows.map(shapeMatch),
  };
}

async function entry(args: Record<string, unknown>): Promise<unknown> {
  const uid = typeof args.uid === 'string' ? args.uid.trim() : '';
  const en = typeof args.entity_number === 'string' || typeof args.entity_number === 'number' ? String(args.entity_number).trim() : '';
  if (!uid && !en) {
    return { error: 'user_error', message: 'Pass uid (e.g. "SDN:36318", from sanctions_screen) or entity_number.' };
  }
  const cfg = supa(args);
  const filter = uid ? `uid=eq.${encodeURIComponent(uid)}` : `entity_number=eq.${encodeURIComponent(en)}`;
  const rows = await pg<Entry[]>(cfg, `csl_entries?${filter}&limit=5`);
  if (rows.length === 0) return { found: false, message: 'No CSL entry with that identifier.' };
  return { found: true, count: rows.length, entries: rows.map(({ search_blob: _sb, ...rest }) => rest) };
}

async function lists(args: Record<string, unknown>): Promise<unknown> {
  const cfg = supa(args);
  const rows = await pg<Array<{ list_abbr: string; source: string; n: number; freshest: string }>>(
    cfg,
    'rpc/csl_list_stats',
    { method: 'POST', body: '{}' },
  ).catch(() => null);
  if (rows) {
    return {
      source: 'trade.gov Consolidated Screening List (hosted by Pipeworx, synced daily)',
      lists: rows.map((r) => ({ code: r.list_abbr, name: LISTS[r.list_abbr] ?? r.source, entries: r.n, last_synced: r.freshest })),
    };
  }
  // Fallback if the stats RPC is unavailable: static list catalog.
  return {
    source: 'trade.gov Consolidated Screening List (hosted by Pipeworx, synced daily)',
    lists: Object.entries(LISTS).map(([code, name]) => ({ code, name })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'sanctions_screen':
        return await screen(args);
      case 'sanctions_entry':
        return await entry(args);
      case 'sanctions_lists':
        return await lists(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
