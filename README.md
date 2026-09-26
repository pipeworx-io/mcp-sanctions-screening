# mcp-sanctions-screening

Sanctions Screening MCP — screen people, companies, vessels, and aircraft

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `sanctions_screen` | Screen a person, company, vessel, or aircraft name against the US restricted-party lists — OFAC SDN sanctions, Sectoral Sanctions (SSI), Chinese Military-Industrial Complex (CMIC), BIS Entity List / Denied Persons / Military End User, State ITAR Debarred, and the DHS UFLPA Entity List for Xinjiang forced-labor import bans (~26k entries, synced daily). Fuzzy name matching with a 0-1 relevance score, matched aliases, programs, addresses, and which list each hit is on. Use for KYB / KYC / AML / export-control checks, and to check whether a supplier is subject to the forced-labor import ban before importing. Returns an empty matches array when the name is clear. Handles CYRILLIC names — Russian, Ukrainian, Serbian: the lists are held in Latin script, so a Cyrillic name is romanised into a small candidate set (both conventions: г as g or h, и as i or y, я as ya or ia) and every form is screened, with matched_form on each hit naming the spelling that produced it. So "Сбербанк" returns the same matches as "Sberbank". A name in a script we do NOT romanise (Greek, Arabic, Hebrew, Han, Japanese, Korean, Devanagari, Thai) still cannot be compared, and is refused with clear:null / screened:false rather than reported clear — pass the Latin transliteration used on the list. |
| `sanctions_entry` | Get the full Consolidated Screening List record for one entry by its uid (from sanctions_screen results, e.g. "SDN:12345") or by OFAC entity number. Returns every field: all aliases, addresses, identity documents (passports, tax IDs, IMO numbers, crypto wallet addresses), sanction programs, license requirements, Federal Register notice, vessel details, and remarks. |
| `sanctions_lists` | List the US restricted-party lists this pack screens against, with entry counts and data freshness (last sync time). Use to cite coverage in a compliance report: OFAC SDN/SSI/CMIC, BIS Entity List/DPL/UVL/MEU, State ITAR-Debarred/ISN, and the DHS UFLPA Entity List. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sanctions-screening": {
      "url": "https://gateway.pipeworx.io/sanctions-screening/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sanctions-screening/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sanctions_screen \
  -H 'Content-Type: application/json' \
  -d '{"name":"Rosneft"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sanctions_screen`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sanctions-screening": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sanctions-screening"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sanctions-screening
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sanctions Screening data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
