interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Sanctions Screening MCP — screen people, companies, vessels, and aircraft
 * against the US Consolidated Screening List (CSL): the 12 US government
 * restricted-party lists merged — OFAC SDN, Sectoral Sanctions (SSI), Chinese
 * Military-Industrial Complex (CMIC), BIS Entity List / Denied Persons /
 * Unverified / Military End User, State Department ITAR Debarred and
 * Nonproliferation Sanctions, and more — plus the DHS UFLPA Entity List.
 *
 * Entries are synced daily by the csl-sync edge function — the CSL from
 * trade.gov's consolidated file, and UFLPA scraped from dhs.gov in the same
 * pass (it is not in the consolidated file, and csl-sync's delist sweep would
 * wipe rows written by any other process). Keyless for callers, fuzzy-matched
 * (trigram) with a relevance score. KYB/compliance companion to
 * companies-house + vies-eu.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Sanctions Screening');
}


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
  UFLPA: 'Uyghur Forced Labor Prevention Act Entity List (DHS)',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'sanctions_screen',
    description:
      'Screen a person, company, vessel, or aircraft name against the US restricted-party lists — OFAC SDN sanctions, Sectoral Sanctions (SSI), Chinese Military-Industrial Complex (CMIC), BIS Entity List / Denied Persons / Military End User, State ITAR Debarred, and the DHS UFLPA Entity List for Xinjiang forced-labor import bans (~26k entries, synced daily). Fuzzy name matching with a 0-1 relevance score, matched aliases, programs, addresses, and which list each hit is on. Use for KYB / KYC / AML / export-control checks, and to check whether a supplier is subject to the forced-labor import ban before importing. Returns an empty matches array when the name is clear. Handles CYRILLIC names — Russian, Ukrainian, Serbian: the lists are held in Latin script, so a Cyrillic name is romanised into a small candidate set (both conventions: г as g or h, и as i or y, я as ya or ia) and every form is screened, with matched_form on each hit naming the spelling that produced it. So "Сбербанк" returns the same matches as "Sberbank". A name in a script we do NOT romanise (Greek, Arabic, Hebrew, Han, Japanese, Korean, Devanagari, Thai) still cannot be compared, and is refused with clear:null / screened:false rather than reported clear — pass the Latin transliteration used on the list.',
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
      'List the US restricted-party lists this pack screens against, with entry counts and data freshness (last sync time). Use to cite coverage in a compliance report: OFAC SDN/SSI/CMIC, BIS Entity List/DPL/UVL/MEU, State ITAR-Debarred/ISN, and the DHS UFLPA Entity List.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Cyrillic → Latin romanisation
//
// The US consolidated lists are held in LATIN script, so a Cyrillic name can
// never match a row (fleet #1236, and b92c929d before it: "Владимир Путин"
// screened CLEAR while "Vladimir Putin" returns 10 matches). Refusing the
// query stopped the wrong answer but pushed the romanisation onto the caller —
// and our top keyed caller screens natively-Cyrillic Ukrainian and Moldovan
// suppliers, so that is most of their traffic. So we romanise it ourselves and
// screen both forms.
//
// The lists use BGN/PCGN-style romanisation and OFAC records carry several
// spellings as aliases, but romanisation is genuinely ambiguous — г is g in
// Russian and h in Ukrainian, и is i or y, я is ya or ia — so one string is a
// coin flip. We generate a small CANDIDATE SET instead: a base romanisation
// plus a handful of global variants along the axes that actually differ
// between the Russian and Ukrainian conventions, and screen each.
//
// Global, not per-occurrence: a name is romanised under one convention
// throughout, so flipping г→h in one syllable and not the next produces
// spellings no agency ever wrote. Four axes, ≤16 combinations before dedupe,
// capped at MAX_CANDIDATES round-trips.
type Axis = 'iy' | 'g' | 'ya' | 'kh';

// Axis order sets candidate order: n counts up from 0 (all defaults), so
// single-axis variants come before combinations and survive the cap.
const AXIS_ORDER: Axis[] = ['iy', 'g', 'ya', 'kh'];

// A plain string is unambiguous; [axis, default, variant] flips with its axis.
const CYRILLIC_MAP: Record<string, string | [Axis, string, string]> = {
  а: 'a', б: 'b', в: 'v', г: ['g', 'g', 'h'], ґ: 'g', д: 'd', е: 'e',
  ё: ['ya', 'yo', 'io'], є: ['ya', 'ye', 'ie'], ж: 'zh', з: 'z',
  и: ['iy', 'i', 'y'], і: 'i', ї: ['ya', 'yi', 'i'], й: ['iy', 'y', 'i'],
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ў: 'w', ф: 'f', х: ['kh', 'kh', 'h'], ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: ['ya', 'yu', 'iu'],
  я: ['ya', 'ya', 'ia'],
  // South Slavic Cyrillic — Serbian, Macedonian, Montenegrin.
  ђ: 'dj', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ѕ: 'dz', ќ: 'k', ѓ: 'g',
};

// Any Cyrillic codepoint, including letters we deliberately do NOT map
// (Bashkir ҫ, Chuvash ӑ, Kazakh ә…). A leftover here fails the candidate, which
// is what keeps a PARTIAL romanisation from reporting a name clear.
const CYRILLIC = /[\u0400-\u04ff\u0500-\u052f]/;

const MAX_CANDIDATES = 6;

function romaniseWord(word: string, pick: (axis: Axis) => boolean): string {
  // "ГАЗПРОМ" should romanise to GAZPROM, not GAzprom — but "Шойгу" wants
  // Shoygu, not SHoygu, so case follows the word, not the character.
  const allCaps = word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
  let out = '';
  for (const ch of word) {
    const lower = ch.toLowerCase();
    const entry = CYRILLIC_MAP[lower];
    if (entry === undefined) { out += ch; continue; }
    const lat = typeof entry === 'string' ? entry : (pick(entry[0]) ? entry[2] : entry[1]);
    if (!lat) continue;
    if (ch === lower) out += lat;
    else out += allCaps ? lat.toUpperCase() : lat[0].toUpperCase() + lat.slice(1);
  }
  return out;
}

/**
 * Latin romanisations of a Cyrillic name, most conventional first.
 *
 * Returns [] when there is nothing to romanise, when every candidate still
 * carries an unmapped Cyrillic letter, or when the input is not Cyrillic —
 * and an empty set is what re-arms the refusal in `screen`. That is the whole
 * safety property: silence here must never read as "clear".
 */
export function cyrillicCandidates(name: string): string[] {
  if (!CYRILLIC.test(name)) return [];
  const present = new Set<Axis>();
  for (const ch of name.toLowerCase()) {
    const e = CYRILLIC_MAP[ch];
    if (Array.isArray(e)) present.add(e[0]);
  }
  const axes = AXIS_ORDER.filter((a) => present.has(a));
  const out: string[] = [];
  for (let n = 0; n < (1 << axes.length) && out.length < MAX_CANDIDATES; n++) {
    const pick = (a: Axis) => ((n >> axes.indexOf(a)) & 1) === 1;
    const cand = name.split(/(\s+)/).map((w) => romaniseWord(w, pick)).join('').trim();
    if (cand.length >= 2 && cand !== name && !CYRILLIC.test(cand) && !out.includes(cand)) out.push(cand);
  }
  return out;
}

type SupabaseConfig = { url: string; key: string };

function supa(args: Record<string, unknown>): SupabaseConfig {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('sanctions-screening is not configured on this deployment — an operator must enable its data credentials.');
  return { url, key };
}

async function pg<T>(cfg: SupabaseConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Screening store: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

type Entry = Record<string, unknown>;

function shapeMatch(e: Entry, matchedForm: string): Record<string, unknown> {
  return {
    uid: e.uid,
    name: e.name,
    score: e.score,
    // Which of the screened spellings actually produced this hit. For a Latin
    // query that is the query itself; for a Cyrillic one it names the
    // romanisation, so a compliance reviewer can see what was compared.
    matched_form: matchedForm,
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

// Scripts we do NOT romanise. A name in one of these still cannot be compared
// against the Latin lists, so it gets the refusal rather than a verdict.
// Detect by NAMING the non-Latin scripts, not by excluding Latin: the lists
// carry plenty of accented Latin — Ş, Ł, Ø, ñ — and a "not plain ASCII" test
// would refuse to screen those, turning a false-NEGATIVE bug into a
// false-REFUSAL bug on exactly this customer's Romanian and Polish names.
const NON_LATIN = /[\u0400-\u04ff\u0500-\u052f\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0900-\u097f\u0e00-\u0e7f]/;

async function screen(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (name.length < 2) {
    return { error: 'user_error', message: 'Pass a name of at least 2 characters, e.g. {"name": "Rosneft"}.' };
  }
  const lim = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const body = {
    list_filter: typeof args.list === 'string' && args.list.trim() ? args.list.trim() : null,
    type_filter: typeof args.type === 'string' && args.type.trim() ? args.type.trim() : null,
    country_filter: typeof args.country === 'string' && args.country.trim() ? args.country.trim() : null,
    lim,
  };
  const cfg = supa(args);
  const search = (q: string) =>
    pg<Entry[]>(cfg, 'rpc/csl_screen', { method: 'POST', body: JSON.stringify({ ...body, q }) });

  // Screen the name as given AND every romanisation of it. Both, not either:
  // some CSL rows do carry a Cyrillic alias, so the original can hit on its
  // own, and dropping it would lose those.
  const candidates = cyrillicCandidates(name);
  const forms = [name, ...candidates];
  const results = await Promise.all(forms.map(search));

  let matches: Array<Record<string, unknown>>;
  if (forms.length === 1) {
    // Single-form path — the overwhelming majority of traffic. Pass the rows
    // through untouched so a Latin screen is byte-for-byte what it always was,
    // including the order the RPC ranked them in.
    matches = results[0].map((r) => shapeMatch(r, name));
  } else {
    // Merge across forms, best score per uid wins. `sort` is stable and the RPC
    // already returns score-descending, so a name with one candidate comes back
    // in exactly the order that candidate would have returned on its own.
    const best = new Map<string, { row: Entry; form: string }>();
    results.forEach((rows, i) => {
      for (const row of rows) {
        const uid = String(row.uid);
        const prev = best.get(uid);
        if (!prev || Number(row.score) > Number(prev.row.score)) best.set(uid, { row, form: forms[i] });
      }
    });
    matches = [...best.values()]
      .sort((a, b) => Number(b.row.score) - Number(a.row.score))
      .slice(0, lim)
      .map(({ row, form }) => shapeMatch(row, form));
  }

  const listCount = Object.keys(LISTS).length;

  // The refusal, unchanged in substance from b92c929d and deliberately still
  // here: a non-Latin name we could not romanise cannot be compared, so a
  // zero-row result says nothing about the entity — only that we never looked.
  // `clear` is WITHHELD (not false, which would wrongly imply a hit).
  //
  // It now fires on a narrower set — the scripts cyrillicCandidates() does not
  // cover (Han, Arabic, Hebrew, Greek, Devanagari, Thai, Japanese, Korean), and
  // Cyrillic containing a letter outside CYRILLIC_MAP, which yields no
  // candidate at all. Keeping it armed for the partial case is the point: a
  // transliterator that romanises most of a name and silently reports the rest
  // clear is the same false-negative wearing a better hat.
  if (matches.length === 0 && candidates.length === 0 && NON_LATIN.test(name)) {
    return {
      query: name,
      matches_found: 0,
      clear: null,
      screened: false,
      reason: 'non_latin_name_not_transliterated',
      note:
        `NOT SCREENED — this is not a clean result. "${name}" is written in a script we do not romanise, and the ` +
        `${listCount} US restricted-party lists are held in Latin script, so zero matches here means the name ` +
        `could not be compared, NOT that the party is unsanctioned. Re-run with the Latin transliteration used ` +
        `on the list. Where an official English or transliterated legal name exists, screen that. (Cyrillic is ` +
        `romanised automatically and does not reach this path.)`,
      matches: [],
    };
  }

  const romanised = candidates.length > 0;
  const matchedForms = [...new Set(matches.map((m) => String(m.matched_form)))];
  const formList = candidates.map((c) => `"${c}"`).join(', ');

  return {
    query: name,
    ...(romanised
      ? {
          script: 'Cyrillic',
          transliterated: true,
          // Every spelling that was actually compared against the lists, and
          // the subset that hit. A caller auditing a compliance decision needs
          // to see what we searched, not just what we found.
          screened_forms: forms,
          matched_forms: matchedForms,
        }
      : {}),
    matches_found: matches.length,
    clear: matches.length === 0,
    screened: true,
    note: romanised
      ? matches.length === 0
        ? `No matches on any of the ${listCount} US restricted-party lists. "${name}" is Cyrillic and the lists are ` +
          `held in Latin script, so it was romanised and screened as ${candidates.length} Latin form(s) — ${formList} — ` +
          `alongside the original. This result is only as good as that romanisation: agencies spell a name the way ` +
          `they themselves romanised it, so where this party has an official English or romanised legal name, screen ` +
          `that too. This is a name screen, not a full identity verification.`
        : `"${name}" is Cyrillic, so it was romanised and screened as ${candidates.length} Latin form(s) — ${formList} — ` +
          `alongside the original; each match carries the matched_form that produced it. Review matches — fuzzy name ` +
          `matching produces candidates, not confirmed identity matches. Use sanctions_entry(uid) for the full record.`
      : matches.length === 0
        ? `No matches on any of the ${listCount} US restricted-party lists screened. This is a name screen, not a ` +
          `full identity verification, and it compares LATIN script only — a party whose name you hold in another ` +
          `script must be transliterated before this result means anything (Cyrillic we do for you).`
        : 'Review matches — fuzzy name matching produces candidates, not confirmed identity matches. Use sanctions_entry(uid) for the full record.',
    matches,
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
      source: 'trade.gov Consolidated Screening List (synced daily)',
      lists: rows.map((r) => ({ code: r.list_abbr, name: LISTS[r.list_abbr] ?? r.source, entries: r.n, last_synced: r.freshest })),
    };
  }
  // Fallback if the stats RPC is unavailable: static list catalog.
  return {
    source: 'trade.gov Consolidated Screening List (synced daily)',
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
