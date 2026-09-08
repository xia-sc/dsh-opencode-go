/**
 * @dsh-plugins/dsh-opencode-go — usage ledger: per-request metering records,
 * aggregation, and JSONL persistence. No Services, no network; file I/O is
 * injectable so tests run hermetically.
 *
 * Billing vocabulary matches the provider: one record per finished stream
 * (retries are separate billable calls), usage chunks supply the counters,
 * and streams without usage still leave a zero-count row so gaps stay
 * visible instead of silent.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const USAGE_FILENAME = "usage.jsonl";

/** Plugin-owned data root: `$DSH_HOME/plugin-data/dsh-opencode-go`. */
export function pluginDataDir(home) {
  const root = home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(root, "plugin-data", "dsh-opencode-go");
}

/** Local calendar day (`YYYY-MM-DD`) for heatmap bucketing. */
export function dayKey(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalize(entry) {
  return {
    t: typeof entry.t === "number" ? entry.t : Date.now(),
    model: String(entry.model ?? "unknown"),
    session: entry.session === undefined || entry.session === null ? null : String(entry.session),
    sessionHeader: entry.sessionHeader === undefined || entry.sessionHeader === null ? null : String(entry.sessionHeader),
    purpose: entry.purpose === undefined || entry.purpose === null ? null : String(entry.purpose),
    input: num(entry.input),
    output: num(entry.output),
    cacheRead: num(entry.cacheRead),
    cacheWrite: num(entry.cacheWrite),
    reasoning: num(entry.reasoning),
    finish: String(entry.finish ?? "unknown"),
  };
}

/**
 * Aggregate records into totals, per-model rows, and per-day buckets.
 * Pure: same input, same output — the RPC layer and tests share it.
 */
export function summarize(records, days = 120) {
  const now = Date.now();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (Math.max(1, days) - 1));
  const from = start.getTime();
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessions: 0 };
  const byModel = {};
  const byDay = new Map();
  const sessions = new Set();
  for (const record of records) {
    if (record.t < from) continue;
    totals.requests += 1;
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.reasoning += record.reasoning;
    if (record.session !== null) sessions.add(record.session);
    const row = byModel[record.model] ?? (byModel[record.model] = { model: record.model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    row.requests += 1;
    row.input += record.input;
    row.output += record.output;
    row.cacheRead += record.cacheRead;
    row.cacheWrite += record.cacheWrite;
    row.reasoning += record.reasoning;
    const day = dayKey(record.t);
    const bucket = byDay.get(day) ?? { date: day, requests: 0, input: 0, output: 0, cacheRead: 0 };
    bucket.requests += 1;
    bucket.input += record.input;
    bucket.output += record.output;
    bucket.cacheRead += record.cacheRead;
    byDay.set(day, bucket);
  }
  totals.sessions = sessions.size;
  return {
    generatedAt: now,
    days: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    byModel: Object.values(byModel).sort((a, b) => b.input - a.input),
    totals,
  };
}

/**
 * One day's drill-down: totals plus per-session rows. Sessions group by the
 * dsh session id, falling back to the sent header when the loop stamped
 * none — so every billable row lands somewhere visible. Pure.
 */
export function summarizeDay(records, date) {
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessions: 0 };
  const groups = new Map();
  for (const record of records) {
    if (dayKey(record.t) !== date) continue;
    const key = record.session ?? `header:${record.sessionHeader ?? "unknown"}`;
    let row = groups.get(key);
    if (row === undefined) {
      row = {
        session: record.session,
        sessionHeader: record.sessionHeader,
        requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        models: [], purposes: [],
      };
      groups.set(key, row);
    }
    row.requests += 1;
    row.input += record.input;
    row.output += record.output;
    row.cacheRead += record.cacheRead;
    row.cacheWrite += record.cacheWrite;
    row.reasoning += record.reasoning;
    if (!row.models.includes(record.model)) row.models.push(record.model);
    // The latest sent header wins: normally stable per conversation, but a
    // regenerated fallback id must not stick to a stale value.
    if (record.sessionHeader !== null) row.sessionHeader = record.sessionHeader;
    if (record.purpose !== null && !row.purposes.includes(record.purpose)) row.purposes.push(record.purpose);
    totals.requests += 1;
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.reasoning += record.reasoning;
  }
  totals.sessions = groups.size;
  return {
    date,
    totals,
    sessions: [...groups.values()].sort((a, b) => b.input - a.input),
  };
}
/**
 * Wrap one pump generator: pass chunks through untouched while capturing the
 * terminal usage/finish, then record exactly one row. Aborts, consumer
 * early-exits, and adapter throws all record — with zero counters when no
 * usage was observed — so the ledger mirrors billable reality instead of
 * the happy path.
 */
export async function* meteredStream(source, meta, record) {
  let usage = null;
  let finish = null;
  let errorCode = null;
  let settled = false;
  const done = (kind) => {
    if (settled) return;
    settled = true;
    record({
      t: meta.t,
      model: meta.model,
      session: meta.session ?? null,
      sessionHeader: meta.sessionHeader ?? null,
      purpose: meta.purpose ?? null,
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
      reasoning: usage?.reasoningTokens ?? 0,
      finish: kind,
    });
  };
  try {
    for await (const chunk of source) {
      if (chunk !== null && typeof chunk === "object") {
        if (chunk.type === "usage" && chunk.usage) usage = chunk.usage;
        if (chunk.type === "finish" && chunk.reason) finish = chunk.reason;
      }
      yield chunk;
    }
    done(finish?.kind ?? "aborted");
  } catch (error) {
    // DOMException abort/timeout reasons carry a numeric legacy `code`
    // (e.g. 23 for TimeoutError, 20 for AbortError) that reads as noise in
    // the ledger; prefer the human-readable `name` for those so a row says
    // `error:TimeoutError` instead of `error:23`. LlmErrors keep their
    // string `code` (TIMEOUT, RATE_LIMIT, ...) as before.
    errorCode =
      error instanceof DOMException && typeof error.code === "number"
        ? error.name
        : error?.code ?? error?.name ?? "unknown";
    done(`error:${errorCode}`);
    throw error;
  }
}

/**
 * Append-only JSONL ledger with debounced... no — immediate serialized
 * appends (one line per record, crash-safe), full reload at boot, and
 * archive-on-reset. File I/O is injected; pass node fs in production.
 */
export function createUsageLedger({ dir, io = { appendFile, mkdir, readFile, rename, writeFile }, now = Date.now } = {}) {
  const file = () => join(dir, USAGE_FILENAME);
  const records = [];
  let chain = Promise.resolve();
  const serialize = (work) => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    get size() {
      return records.length;
    },
    async load() {
      let text;
      try {
        text = await io.readFile(file(), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return { loaded: 0, skipped: 0 };
        throw error;
      }
      let loaded = 0;
      let skipped = 0;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          records.push(normalize(JSON.parse(trimmed)));
          loaded += 1;
        } catch {
          skipped += 1;
        }
      }
      return { loaded, skipped };
    },
    record(entry) {
      const row = normalize({ ...entry, t: entry.t ?? now() });
      records.push(row);
      return serialize(async () => {
        await io.mkdir(dir, { recursive: true });
        await io.appendFile(file(), JSON.stringify(row) + "\n", "utf8");
      });
    },
    summary(days) {
      return summarize(records, days);
    },
    day(date) {
      return summarizeDay(records, date);
    },
    async reset() {
      const stamp = new Date(now());
      const pad = (n) => String(n).padStart(2, "0");
      const archived = `usage-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.bak.jsonl`;
      await serialize(async () => {
        try {
          await io.rename(file(), join(dir, archived));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      });
      records.length = 0;
      return { archived };
    },
  };
}
