/**
 * alibaba-usage — remaining Alibaba Cloud Model Studio Token Plan quota in percent.
 *
 * Shows the remaining percentages per quota window (5h / weekly / monthly) and the time
 * until the next reset in pi's status line. Data comes from the official Bailian console
 * gateway (the same protocol as the `bl usage token-plan` CLI), without depending on the
 * CLI itself.
 *
 * Auth: console token (an sk-sp- API key does not work for this gateway).
 *   /alibaba-usage login   — browser login (does not block pi; a Chromium browser is preferred)
 *   /alibaba-usage cancel  — cancel a pending login
 *   /alibaba-usage         — detailed panel + forced refresh
 *   /alibaba-usage refresh — refresh only
 *   /alibaba-usage logout  — delete the saved token
 *   /alibaba-usage token <token> — import a token manually (if the browser cannot reach 127.0.0.1)
 *
 * If the Bailian CLI is installed and `bl auth login --console` has been run, the token
 * is picked up automatically from ~/.bailian/config.json.
 *
 * Config (optional): ~/.pi/agent/alibaba-usage/config.json
 *   {
 *     "provider": "alibaba-plan",        // pi provider to show status for
 *     "refreshIntervalMs": 300000,       // refresh interval (5 minutes)
 *     "consoleRegion": "ap-southeast-1", // forced region (otherwise auto-detected)
 *     "consoleSite": "international",    // international | domestic
 *     "enabled": true
 *   }
 *
 * State files: ~/.pi/agent/alibaba-usage/{auth.json,state.json} (permissions 0600/0700).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const STATUS_KEY = "alibaba-usage";
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULT_REFRESH_MS = 5 * MINUTE_MS;
const MAX_TICK_MS = 30 * SECOND_MS;
const MIN_TICK_MS = SECOND_MS;
const MIN_ATTEMPT_GAP_MS = 10 * SECOND_MS;
const CLAIM_TTL_MS = 90 * SECOND_MS;
const STALE_REPORT_MAX_AGE_MS = HOUR_MS;
const BACKOFF_BASE_MS = MINUTE_MS;
const BACKOFF_MAX_MS = 30 * MINUTE_MS;
const LOGIN_EXPIRED_RETRY_MS = 10 * MINUTE_MS;
const REQUEST_TIMEOUT_MS = 20 * SECOND_MS;
const LOGIN_TIMEOUT_MS = 10 * MINUTE_MS;
const MAX_BODY_BYTES = 64 * 1024;

const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const WINDOW_RE = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;
const UNIT_HOURS: Record<string, number> = { Hour: 1, Day: 24, Week: 168, Month: 720 };

type ConsoleSite = "international" | "domestic";

interface Gateway {
  host: string;
  action: string;
}

// Gateway map from the official Bailian CLI (bailian-cli-core).
const GATEWAYS: Record<string, Record<ConsoleSite, Gateway>> = {
  "cn-beijing": {
    domestic: { host: "bailian-cs.console.aliyun.com", action: "BroadScopeAspnGateway" },
    international: { host: "bailian-cs.console.alibabacloud.com", action: "BroadScopeAspnGateway" },
  },
  "ap-southeast-1": {
    domestic: { host: "modelstudio-cs.console.aliyun.com", action: "IntlBroadScopeAspnGateway" },
    international: { host: "bailian-singapore-cs.alibabacloud.com", action: "IntlBroadScopeAspnGateway" },
  },
};

const CONSOLE_BASE: Record<ConsoleSite, string> = {
  domestic: "https://bailian.console.aliyun.com",
  international: "https://modelstudio.console.alibabacloud.com",
};

interface UsageWindow {
  key: string; // per5Hour
  label: string; // 5h
  durationHours: number;
  /** Used, 0..100 */
  usedPercent: number;
  /** Window reset epoch ms, if known */
  resetAt?: number;
}

interface UsageReport {
  windows: UsageWindow[];
  fetchedAt: number;
}

interface SharedState {
  owner?: string;
  claimedAt?: number;
  updatedAt?: number;
  report?: UsageReport;
  error?: string;
  unavailable?: boolean;
  loginExpired?: boolean;
  failures?: number;
  nextRetryAt?: number;
}

interface AuthStore {
  access_token: string;
  console_site?: ConsoleSite;
  console_region?: string;
  saved_at?: number;
}

interface Config {
  provider: string;
  refreshIntervalMs: number;
  consoleRegion?: string;
  consoleSite?: ConsoleSite;
  enabled: boolean;
}

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const stateDir = join(getAgentDir(), "alibaba-usage");
const authPath = join(stateDir, "auth.json");
const statePath = join(stateDir, "state.json");
const configPath = join(stateDir, "config.json");

function ensureDir(): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  ensureDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}

function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(configPath) ?? {};
  return {
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : "alibaba-plan",
    refreshIntervalMs:
      typeof raw.refreshIntervalMs === "number" && raw.refreshIntervalMs >= 30 * SECOND_MS
        ? raw.refreshIntervalMs
        : DEFAULT_REFRESH_MS,
    consoleRegion: typeof raw.consoleRegion === "string" ? raw.consoleRegion : undefined,
    consoleSite: raw.consoleSite === "domestic" || raw.consoleSite === "international" ? raw.consoleSite : undefined,
    enabled: raw.enabled !== false,
  };
}

function loadOwnAuth(): AuthStore | undefined {
  const raw = readJson<AuthStore>(authPath);
  return raw && typeof raw.access_token === "string" && raw.access_token ? raw : undefined;
}

/** Token from the Bailian CLI config (`bl auth login --console`), if present. */
function loadBlAuth(): AuthStore | undefined {
  const raw = readJson<Record<string, unknown>>(join(homedir(), ".bailian", "config.json"));
  if (!raw) return undefined;
  const token = typeof raw.access_token === "string" ? raw.access_token : typeof raw.accessToken === "string" ? raw.accessToken : undefined;
  if (!token) return undefined;
  const site = raw.console_site === "domestic" || raw.console_site === "international" ? (raw.console_site as ConsoleSite) : undefined;
  const region = typeof raw.console_region === "string" ? raw.console_region : undefined;
  return { access_token: token, console_site: site, console_region: region };
}

function resolveAuth(): AuthStore | undefined {
  const env = process.env.BAILIAN_CONSOLE_TOKEN;
  if (env && env.trim()) return { access_token: env.trim() };
  return loadOwnAuth() ?? loadBlAuth();
}

// ---------------------------------------------------------------------------
// Region / site / gateway
// ---------------------------------------------------------------------------

function gatewayFor(region: string, site: ConsoleSite): Gateway {
  return GATEWAYS[region]?.[site] ?? GATEWAYS["ap-southeast-1"][site];
}

function regionFromBaseUrl(baseUrl: string | undefined): { region: string; site: ConsoleSite } | undefined {
  if (!baseUrl) return undefined;
  if (baseUrl.includes("cn-beijing")) return { region: "cn-beijing", site: "domestic" };
  if (baseUrl.includes("maas.aliyuncs.com") || baseUrl.includes("ap-southeast-1"))
    return { region: "ap-southeast-1", site: "international" };
  return undefined;
}

async function resolveConsoleTarget(
  ctx: ExtensionContext,
  config: Config,
  auth: AuthStore | undefined,
): Promise<{ region: string; site: ConsoleSite }> {
  if (config.consoleRegion && config.consoleSite) return { region: config.consoleRegion, site: config.consoleSite };
  let detected: { region: string; site: ConsoleSite } | undefined;
  try {
    const providerAuth = (await ctx.modelRegistry.getProviderAuth(config.provider)) as { baseUrl?: string } | undefined;
    detected = regionFromBaseUrl(providerAuth?.baseUrl);
  } catch {
    // the provider may not be configured — that's fine
  }
  const fallback = detected ?? { region: "ap-southeast-1", site: "international" as ConsoleSite };
  const region = config.consoleRegion ?? auth?.console_region ?? fallback.region;
  const site = config.consoleSite ?? auth?.console_site ?? (GATEWAYS[region] ? fallback.site : "international");
  return { region, site: GATEWAYS[region]?.[site] ? site : "international" };
}

// ---------------------------------------------------------------------------
// Quota request
// ---------------------------------------------------------------------------

class UsageError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "unavailable" | "error",
  ) {
    super(message);
  }
}

/** Extracts per* fields from the response regardless of wrapper depth (data / DataV2 / …). */
function collectWindowFields(node: unknown, depth: number, out: Map<string, number>): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (WINDOW_RE.test(key)) {
      const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (Number.isFinite(num)) out.set(key, num);
    } else if (value && typeof value === "object") {
      collectWindowFields(value, depth + 1, out);
    }
  }
}

function parseWindows(fields: Map<string, number>): UsageWindow[] {
  const grouped = new Map<string, { count: number; unit: string; percentage?: number; resetTime?: number }>();
  for (const [key, value] of fields) {
    const m = WINDOW_RE.exec(key);
    if (!m) continue;
    const [, countStr, unit, suffix] = m;
    const groupKey = `per${countStr}${unit}`;
    const entry = grouped.get(groupKey) ?? { count: Number(countStr), unit };
    if (suffix === "Percentage") entry.percentage = value;
    else entry.resetTime = value;
    grouped.set(groupKey, entry);
  }
  const windows: UsageWindow[] = [];
  for (const [key, entry] of grouped) {
    if (entry.percentage === undefined) continue;
    // Used fraction 0..1 (official CLI contract).
    const ratio = Math.min(1, Math.max(0, entry.percentage));
    const durationHours = entry.count * (UNIT_HOURS[entry.unit] ?? 1);
    windows.push({
      key,
      label: windowLabel(entry.count, entry.unit),
      durationHours,
      usedPercent: Math.round(ratio * 1000) / 10,
      resetAt: entry.resetTime !== undefined && entry.resetTime > 0 ? entry.resetTime : undefined,
    });
  }
  return windows.sort((a, b) => a.durationHours - b.durationHours);
}

function windowLabel(count: number, unit: string): string {
  switch (unit) {
    case "Hour":
      return `${count}h`;
    case "Day":
      return `${count}d`;
    case "Week":
      return count === 1 ? "1w" : `${count}w`;
    case "Month":
      return count === 1 ? "1mo" : `${count}mo`;
    default:
      return `${count}${unit}`;
  }
}

async function fetchUsageReport(token: string, region: string, site: ConsoleSite): Promise<UsageReport> {
  const gateway = gatewayFor(region, site);
  const params = JSON.stringify({
    Api: USAGE_API,
    V: "1.0",
    Data: {
      cornerstoneParam: {
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        consoleSite: "BAILIAN_ALIYUN",
      },
    },
  });
  const url = `https://${gateway.host}/cli/api.json?action=${gateway.action}&product=sfm_bailian&api=${encodeURIComponent(USAGE_API)}`;
  const body = new URLSearchParams({ params, region }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UsageError(`сеть: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
  if (!response.ok) {
    throw new UsageError(`HTTP ${response.status} ${response.statusText}`, "error");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UsageError("некорректный JSON в ответе шлюза", "error");
  }
  const envelope = (payload as { data?: { success?: boolean; errorCode?: unknown; errorMsg?: unknown } })?.data;
  if (envelope && envelope.success === false && envelope.errorCode !== undefined) {
    const code = typeof envelope.errorCode === "string" ? envelope.errorCode : JSON.stringify(envelope.errorCode);
    if (code.includes("NotLogined")) {
      throw new UsageError("console-сессия истекла — нужен повторный вход", "auth");
    }
    const msg = typeof envelope.errorMsg === "string" && envelope.errorMsg ? envelope.errorMsg : code;
    throw new UsageError(msg, "error");
  }
  const fields = new Map<string, number>();
  collectWindowFields(payload, 0, fields);
  const windows = parseWindows(fields);
  if (windows.length === 0) {
    // An empty response is not treated as zero/unlimited — keep the last-good report.
    throw new UsageError("шлюз не вернул окна квоты", "unavailable");
  }
  return { windows, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Shared state (cache + leader lock + backoff for multiple pi instances)
// ---------------------------------------------------------------------------

function readState(): SharedState | undefined {
  return readJson<SharedState>(statePath);
}

function claimRefresh(instanceId: string): boolean {
  const state = readState();
  const now = Date.now();
  if (state?.owner && state.owner !== instanceId && state.claimedAt && now - state.claimedAt < CLAIM_TTL_MS) {
    return false;
  }
  try {
    writeJsonAtomic(statePath, { ...state, owner: instanceId, claimedAt: now });
    return true;
  } catch {
    return false;
  }
}

function isRefreshDue(state: SharedState | undefined, instanceId: string, now: number): boolean {
  if (!state) return true;
  if (now < (state.nextRetryAt ?? 0)) return false;
  if (state.owner && state.owner !== instanceId && state.claimedAt && now - state.claimedAt < CLAIM_TTL_MS) return false;
  return true;
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

function publishSuccess(report: UsageReport, refreshIntervalMs: number): void {
  const now = Date.now();
  writeJsonAtomic(statePath, {
    owner: undefined,
    claimedAt: now,
    updatedAt: now,
    report,
    failures: 0,
    nextRetryAt: now + refreshIntervalMs,
  } satisfies SharedState);
}

function publishFailure(error: UsageError, refreshIntervalMs: number): void {
  const prev = readState();
  const now = Date.now();
  const failures = (prev?.failures ?? 0) + 1;
  const loginExpired = error.kind === "auth";
  writeJsonAtomic(statePath, {
    ...prev,
    owner: undefined,
    claimedAt: now,
    error: error.message,
    unavailable: error.kind === "unavailable" || loginExpired,
    loginExpired,
    failures,
    nextRetryAt: now + (loginExpired ? LOGIN_EXPIRED_RETRY_MS : backoffMs(failures)),
  } satisfies SharedState);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function remainingPercent(window: UsageWindow): number {
  return Math.max(0, Math.round(100 - window.usedPercent));
}

function formatCountdown(resetAt: number, now: number): string {
  const diffMin = Math.floor(Math.max(0, resetAt - now) / MINUTE_MS);
  if (diffMin <= 0) return "now";
  const d = Math.floor(diffMin / 1440);
  const h = Math.floor((diffMin % 1440) / 60);
  const m = diffMin % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join("");
}

function nextResetAt(report: UsageReport, now: number): number | undefined {
  let best: number | undefined;
  for (const w of report.windows) {
    if (w.resetAt && w.resetAt > now && (best === undefined || w.resetAt < best)) best = w.resetAt;
  }
  return best;
}

// --- @llblab/pi-codex-usage-style display --------------------------------
// Compact "dual" bar: the left half of each cell is the nearest quota window
// (5h), the right half is the next one (weekly). Same glyphs and logic as
// pi-codex-usage, plus a countdown to reset. The monthly window stays in the
// detailed /alibaba-usage panel.

const DUAL_BAR_WIDTH = 10;
const DUAL_BAR_CHARS = ["⠀", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

function isExhausted(window: UsageWindow): boolean {
  return remainingPercent(window) === 0;
}

function filledParts(window: UsageWindow | undefined, totalParts: number): number {
  if (!window || isExhausted(window)) return 0;
  return Math.max(1, Math.round(remainingPercent(window) / (100 / totalParts)));
}

function formatDualLimitBar(primary: UsageWindow, secondary: UsageWindow): string {
  const primaryParts = filledParts(primary, 20);
  const secondaryParts = filledParts(secondary, 20);
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const leftPart = index * 2 + 1;
    const rightPart = leftPart + 1;
    let mask = 0;
    if (primaryParts >= leftPart) mask |= 1;
    if (primaryParts >= rightPart) mask |= 2;
    if (secondaryParts >= leftPart) mask |= 4;
    if (secondaryParts >= rightPart) mask |= 8;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

/** Single window: same braille bar, but all 4 cell quadrants (like codex's formatSingleLimitBar). */
function formatSingleLimitBar(window: UsageWindow): string {
  const filled = filledParts(window, DUAL_BAR_WIDTH * 4);
  const partMasks = [1, 4, 2, 8];
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const cellParts = Math.min(4, Math.max(0, filled - index * 4));
    let mask = 0;
    for (let part = 0; part < cellParts; part++) mask |= partMasks[part] ?? 0;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

/** Countdown like pi-codex-usage: 1.2d / 3.4h / 12m / 40s. */
function formatResetCountdown(resetAt: number, now: number): string {
  const remainingMs = Math.max(0, resetAt - now);
  const tenths = (v: number) => (v % 10 === 0 ? String(v / 10) : (v / 10).toFixed(1));
  if (remainingMs > 24 * HOUR_MS) return `${tenths(Math.max(10, Math.ceil(remainingMs / (144 * MINUTE_MS))))}d`;
  if (remainingMs >= HOUR_MS) return `${tenths(Math.max(10, Math.ceil(remainingMs / (6 * MINUTE_MS))))}h`;
  if (remainingMs >= MINUTE_MS) return `${Math.floor(remainingMs / MINUTE_MS)}m`;
  return `${Math.floor(remainingMs / SECOND_MS)}s`;
}

/** Weekly/monthly windows show whole days left (after a middle dot) instead of an h/m countdown. */
export function isLongWindow(window: UsageWindow): boolean {
  return /Week|Month/.test(window.key);
}

/** Whole days until reset ("6d"); falls back to the h/m/s countdown when <1 day, "now" when past. */
export function formatDaysLeft(resetAt: number, now: number): string {
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return "now";
  const days = Math.floor(remainingMs / (24 * HOUR_MS));
  return days >= 1 ? `${days}d` : formatResetCountdown(resetAt, now);
}

export function statusCountdown(primary: UsageWindow, secondary: UsageWindow | undefined, now: number): string | undefined {
  if (isExhausted(primary) && primary.resetAt) {
    const p = formatResetCountdown(primary.resetAt, now);
    if (secondary?.resetAt) {
      if (isLongWindow(secondary)) return `${p} · ${formatDaysLeft(secondary.resetAt, now)}`;
      return `${p}/${formatResetCountdown(secondary.resetAt, now)}`;
    }
    return isLongWindow(primary) ? `· ${formatDaysLeft(primary.resetAt, now)}` : p;
  }
  const win = secondary ?? primary;
  if (!win.resetAt) return undefined;
  return isLongWindow(win) ? `· ${formatDaysLeft(win.resetAt, now)}` : formatResetCountdown(win.resetAt, now);
}

function formatStatusline(ctx: ExtensionContext, report: UsageReport, stale: boolean): string {
  const now = Date.now();
  const primary = report.windows[0];
  const secondary = report.windows[1];
  const label = ctx.ui.theme.fg("accent", "TP");
  let body: string;
  if (primary && secondary) {
    const bar = formatDualLimitBar(primary, secondary);
    const exhausted = isExhausted(primary) || isExhausted(secondary);
    const barText = ctx.ui.theme.bg(exhausted ? "toolErrorBg" : "userMessageBg", ctx.ui.theme.fg("dim", bar));
    const countdown = statusCountdown(primary, secondary, now);
    body = countdown ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}` : barText;
  } else if (primary) {
    const bar = formatSingleLimitBar(primary);
    const barText = ctx.ui.theme.bg(isExhausted(primary) ? "toolErrorBg" : "userMessageBg", ctx.ui.theme.fg("dim", bar));
    const countdown = statusCountdown(primary, undefined, now);
    body = countdown ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}` : barText;
  } else {
    body = ctx.ui.theme.fg("muted", "n/a");
  }
  let text = `${label} ${body}`;
  if (stale) text += ` ${ctx.ui.theme.fg("dim", "· устарело")}`;
  return text;
}

// --- Widget for pi-fancy-footer ------------------------------------------
// Compatibility via the pi event bus (protocol 1), without depending on the
// pi-fancy-footer package: see its README, "Extension widgets" section.

const FF_PROTOCOL = 1;
const FF_WIDGET_CHANNEL = "pi-fancy-footer:widget";
const FF_READY_CHANNEL = "pi-fancy-footer:ready";
const FF_WIDGET_ID = "alibaba.usage";

type FooterColor = "text" | "accent" | "muted" | "dim" | "success" | "error" | "warning";
const FOOTER_COLORS: readonly FooterColor[] = ["text", "accent", "muted", "dim", "success", "error", "warning"];
function isFooterColor(value: unknown): value is FooterColor {
  return typeof value === "string" && (FOOTER_COLORS as readonly string[]).includes(value);
}

interface FooterSpan {
  text: string;
  color?: FooterColor;
}

// Gauge style mirrors the standard provider-status from pi-fancy-footer
// (shared.ts: GAUGE_STYLES / buildGauge / gaugeSeverity) so the alibaba widget
// looks like the built-in codex/anthropic ones. Width/style/colors are read
// from fancy-footer.json; without the file, defaults apply (blocks, 5 cells).
const FF_GAUGE_STYLES: Record<string, [string, string]> = {
  blocks: ["■", "□"],
  lines: ["━", "─"],
  circles: ["●", "○"],
  parallelograms: ["▰", "▱"],
  diamonds: ["◆", "◇"],
  bars: ["█", "░"],
  stars: ["★", "☆"],
  specks: ["•", "◦"],
};

interface FancyLook {
  width: number;
  filled: string;
  empty: string;
  colors: { ok: FooterColor; warning: FooterColor; error: FooterColor };
  textColor: FooterColor;
  showReset: "off" | "primary" | "all";
  resetMinUsedPercent: number;
}

let fancyLookCache: FancyLook | undefined;
function readFancyLook(): FancyLook {
  if (fancyLookCache) return fancyLookCache;
  const look: FancyLook = {
    width: 5,
    filled: "■",
    empty: "□",
    colors: { ok: "accent", warning: "warning", error: "error" },
    textColor: "dim",
    showReset: "all",
    resetMinUsedPercent: 75,
  };
  try {
    const raw = JSON.parse(readFileSync(join(getAgentDir(), "fancy-footer.json"), "utf8"));
    if (typeof raw.gaugeWidth === "number") look.width = Math.max(3, Math.min(40, Math.floor(raw.gaugeWidth)));
    const style = FF_GAUGE_STYLES[raw.gaugeStyle];
    if (style) {
      look.filled = style[0];
      look.empty = style[1];
    }
    for (const key of ["ok", "warning", "error"] as const) {
      if (isFooterColor(raw.gaugeColors?.[key])) look.colors[key] = raw.gaugeColors[key];
    }
    if (isFooterColor(raw.defaultTextColor)) look.textColor = raw.defaultTextColor;
    const ps = raw.providerStatus;
    if (ps && (ps.showReset === "off" || ps.showReset === "primary" || ps.showReset === "all")) look.showReset = ps.showReset;
    if (ps && typeof ps.resetMinUsedPercent === "number") look.resetMinUsedPercent = ps.resetMinUsedPercent;
  } catch {
    // fancy-footer is not installed or has no config — keep the defaults.
  }
  fancyLookCache = look;
  return look;
}

function formatGaugePercent(value: number): string {
  const displayed = Math.round(value * 10) / 10;
  return Number.isInteger(displayed) ? `${displayed}%` : `${displayed.toFixed(1)}%`;
}

function buildStandardGauge(usedPercent: number, look: FancyLook) {
  const used = Math.max(0, Math.min(100, usedPercent));
  const n = Math.max(1, Math.floor(look.width));
  let filledCells = Math.round((used / 100) * n);
  if (used > 0 && filledCells === 0) filledCells = 1;
  if (used < 100 && filledCells === n) filledCells = n - 1;
  const left = 100 - used;
  const severity: "success" | "warning" | "error" = left < 25 ? "error" : left < 60 ? "warning" : "success";
  const fillColor = severity === "success" ? look.colors.ok : look.colors[severity];
  return {
    filledGlyphs: look.filled.repeat(filledCells),
    emptyGlyphs: look.empty.repeat(n - filledCells),
    percentText: formatGaugePercent(used),
    fillColor,
  };
}

// Reset like provider-status: `~8d2h` / `~3h12m` / `~40m` / `~now`.
// alibaba's resetAt is in milliseconds (the standard uses seconds).
function formatStandardReset(resetAtMs: number | undefined, nowMs: number): string {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return "";
  const remainingMs = resetAtMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "";
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (remainingMs >= dayMs) {
    const days = Math.floor(remainingMs / dayMs);
    const hours = Math.floor((remainingMs % dayMs) / hourMs);
    return `~${days}d${hours > 0 ? `${hours}h` : ""}`;
  }
  if (remainingMs >= hourMs) {
    const hours = Math.floor(remainingMs / hourMs);
    const minutes = Math.floor((remainingMs % hourMs) / minuteMs);
    return `~${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  }
  if (remainingMs >= minuteMs) return `~${Math.floor(remainingMs / minuteMs)}m`;
  return "~now";
}

export function buildFooterWidget(report: UsageReport, now: number) {
  const look = readFancyLook();
  const windows = report.windows.slice(0, 2);
  let text: string;
  let spans: FooterSpan[];
  if (windows.length === 0) {
    text = "n/a";
    spans = [{ text: "n/a" }];
  } else {
    text = "";
    spans = [];
    windows.forEach((win, index) => {
      if (index > 0) {
        text += " ";
        spans.push({ text: " " });
      }
      const gauge = buildStandardGauge(win.usedPercent, look);
      text += `${win.label} ${gauge.filledGlyphs}${gauge.emptyGlyphs} ${gauge.percentText}`;
      spans.push({ text: `${win.label} `, color: look.textColor });
      if (gauge.filledGlyphs) spans.push({ text: gauge.filledGlyphs, color: gauge.fillColor });
      if (gauge.emptyGlyphs) spans.push({ text: gauge.emptyGlyphs, color: "dim" });
      spans.push({ text: ` ${gauge.percentText}`, color: look.textColor });
      if (isLongWindow(win)) {
        // Weekly/monthly: always show whole days left after a middle dot (· 6d),
        // regardless of the resetMinUsedPercent threshold used for short windows.
        if (win.resetAt !== undefined) {
          const days = ` · ${formatDaysLeft(win.resetAt, now)}`;
          text += days;
          spans.push({ text: days, color: "dim" });
        }
      } else {
        const role = index === 0 ? "primary" : "secondary";
        const roleEnabled = look.showReset === "all" || (look.showReset === "primary" && role === "primary");
        const displayedUsed = Math.round(win.usedPercent * 10) / 10;
        if (roleEnabled && win.resetAt !== undefined && displayedUsed >= look.resetMinUsedPercent) {
          const reset = formatStandardReset(win.resetAt, now);
          if (reset) {
            text += ` ${reset}`;
            spans.push({ text: ` ${reset}`, color: "dim" });
          }
        }
      }
    });
  }
  return {
    id: FF_WIDGET_ID,
    label: "Alibaba Token Plan",
    description: "Остаток квоты Alibaba Cloud Model Studio Token Plan",
    content: { type: "text" as const, text, spans },
    icon: { glyphs: { nerd: "󰓅", emoji: "📊", unicode: "%", ascii: "%" }, color: "accent" as const },
    style: { textColor: "dim" as const },
    layout: { row: 0, position: 6, align: "left" as const, enabled: true },
  };
}

function formatDetail(ctx: ExtensionContext, state: SharedState | undefined, region: string, site: ConsoleSite): string {
  const lines: string[] = ["Alibaba Token Plan — остаток квоты"];
  const report = state?.report;
  if (report) {
    const now = Date.now();
    for (const w of report.windows) {
      const remaining = remainingPercent(w);
      const reset = w.resetAt
        ? `сброс через ${formatCountdown(w.resetAt, now)} (${new Date(w.resetAt).toLocaleTimeString()})`
        : "сброс: нет данных (окно ещё не использовалось)";
      lines.push(`  ${w.label.padEnd(5)} ${String(remaining).padStart(3)}% осталось  (использовано ${w.usedPercent}%)  · ${reset}`);
    }
    const ageSec = Math.max(0, Math.round((now - (state?.updatedAt ?? report.fetchedAt)) / SECOND_MS));
    lines.push(`Обновлено ${ageSec < 60 ? `${ageSec}с` : `${Math.floor(ageSec / 60)}м`} назад · ${region} / ${site}`);
  } else {
    lines.push("  данных пока нет");
  }
  if (state?.loginExpired) lines.push("⚠ Console-сессия истекла: /alibaba-usage login");
  else if (state?.error) lines.push(`Последняя ошибка: ${state.error}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Browser login (`bl auth login --console` protocol)
// ---------------------------------------------------------------------------

interface LoginResult {
  accessToken: string;
  consoleSite?: ConsoleSite;
  consoleRegion?: string;
}

function parseLoginPayload(req: IncomingMessage, body: string): LoginResult | undefined {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = url.searchParams.get(n);
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  };
  let token = pick("access_token", "accessToken");
  let site = pick("console_site", "consoleSite");
  let region = pick("console_region", "consoleRegion");

  const method = (req.method ?? "GET").toUpperCase();
  if (!token && body && ["POST", "PUT", "PATCH"].includes(method)) {
    const contentType = String(req.headers["content-type"] ?? "");
    let fields: Record<string, string> = {};
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : parsed;
        for (const [k, v] of Object.entries(data)) if (typeof v === "string") fields[k] = v;
      } catch {
        /* ignore */
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
    } else if (contentType.includes("multipart/form-data")) {
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
      if (boundary) {
        for (const part of body.split(`--${boundary}`)) {
          const nameMatch = /name\s*=\s*["']?([A-Za-z_]+)["']?/i.exec(part);
          if (!nameMatch) continue;
          const sep = part.indexOf("\r\n\r\n");
          if (sep < 0) continue;
          fields[nameMatch[1]] = part.slice(sep + 4).replace(/(\r\n)+$/g, "").trim();
        }
      }
    } else {
      const trimmed = body.trim();
      if (trimmed && !trimmed.startsWith("{") && !trimmed.startsWith("[") && !/\s/.test(trimmed)) token = trimmed;
    }
    token = token ?? fields.access_token ?? fields.accessToken;
    site = site ?? fields.console_site ?? fields.consoleSite;
    region = region ?? fields.console_region ?? fields.consoleRegion;
  }
  if (!token) return undefined;
  return {
    accessToken: token,
    consoleSite: site === "domestic" || site === "international" ? site : undefined,
    consoleRegion: region || undefined,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Safari/Firefox block fetch from an HTTPS page to 127.0.0.1; Chromium allows it.
 * So prefer a Chromium browser for login when one is installed. */
function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      const chromiumApps = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Arc"];
      const app = chromiumApps.find((name) => existsSync(`/Applications/${name}.app`));
      const child = app
        ? spawn("open", ["-a", app, url], { detached: true, stdio: "ignore" })
        : spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return;
    }
    const command = process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the user will open the link manually */
  }
}

async function browserLogin(site: ConsoleSite, onUrl?: (url: string) => void, signal?: AbortSignal): Promise<LoginResult> {
  const consoleBase = CONSOLE_BASE[site];
  const state = randomBytes(16).toString("hex");
  let settled = false;
  let server: Server;

  const done = new Promise<LoginResult>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("время ожидания входа истекло (10 минут)"))), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => finish(() => reject(new Error("вход отменён")));
    signal?.addEventListener("abort", onAbort, { once: true });

    const close = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
    };

    server = createServer(async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== consoleBase) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Origin not allowed");
          return;
        }
        if (origin === consoleBase) res.setHeader("Access-Control-Allow-Origin", consoleBase);
        if (req.method === "OPTIONS") {
          if (origin === consoleBase && req.headers["access-control-request-private-network"] === "true") {
            res.setHeader("Access-Control-Allow-Private-Network", "true");
          }
          res.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("bad state");
          return;
        }
        const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req).catch(() => "") : "";
        const payload = parseLoginPayload(req, body);
        if (settled) {
          res.writeHead(409);
          res.end("login finished");
          return;
        }
        if (!payload) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing access_token");
          return;
        }
        settled = true;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OK");
        close();
        resolve(payload);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("не удалось получить порт"));
    });
  });

  if (signal?.aborted) throw new Error("вход отменён");
  const loginUrl = `${consoleBase}/console-login?notice=127.0.0.1:${port}?state=${encodeURIComponent(state)}`;
  onUrl?.(loginUrl);
  openBrowser(loginUrl);
  return done;
}

// ---------------------------------------------------------------------------
// Status line controller
// ---------------------------------------------------------------------------

export default function alibabaUsage(pi: ExtensionAPI) {
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let config = loadConfig();
  let lastAttemptAt = 0;
  let inFlight: Promise<void> | undefined;
  let tickTimer: TimeoutHandle | undefined;
  let countdownTimer: TimeoutHandle | undefined;
  let shownKey: string | undefined;
  let loginInProgress = false;
  let activeLogin: AbortController | undefined;
  let currentTarget: { region: string; site: ConsoleSite } = { region: "ap-southeast-1", site: "international" };

  const isStaleCtx = (error: unknown) => error instanceof Error && error.message.includes("ctx is stale");

  const isActive = (model: PiModel | undefined) => config.enabled && model?.provider === config.provider;

  const clearTimers = () => {
    if (tickTimer) clearTimeout(tickTimer);
    if (countdownTimer) clearTimeout(countdownTimer);
    tickTimer = undefined;
    countdownTimer = undefined;
  };

  // Publish the widget to pi-fancy-footer (if installed). When the footer is
  // not installed, the events simply go nowhere — the status stays in pi's
  // built-in status line.
  let footerSnapshot: UsageReport | undefined;
  const emitFooter = (report: UsageReport | undefined) => {
    const message = report
      ? { protocol: FF_PROTOCOL, type: "upsert", widget: buildFooterWidget(report, Date.now()) }
      : { protocol: FF_PROTOCOL, type: "remove", id: FF_WIDGET_ID };
    try {
      pi.events?.emit(FF_WIDGET_CHANNEL, message);
    } catch {
      /* event bus unavailable — that's fine */
    }
  };
  const publishFooter = (report: UsageReport | undefined) => {
    footerSnapshot = report;
    emitFooter(report);
  };
  const stopFooterReady = pi.events?.on(FF_READY_CHANNEL, (message) => {
    if (message && typeof message === "object" && (message as { protocol?: unknown }).protocol === FF_PROTOCOL) {
      emitFooter(footerSnapshot);
    }
  });

  const setStatus = (ctx: ExtensionContext, text: string | undefined, report?: UsageReport) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch (error) {
      if (!isStaleCtx(error)) throw error;
    }
    publishFooter(report);
  };

  const scheduleCountdown = (ctx: ExtensionContext, report: UsageReport) => {
    if (countdownTimer) clearTimeout(countdownTimer);
    const reset = nextResetAt(report, Date.now());
    if (reset === undefined) return;
    const delay = Math.min(Math.max(SECOND_MS, reset - Date.now() + SECOND_MS), MAX_TICK_MS);
    countdownTimer = setTimeout(() => {
      try {
        if (!isActive(ctx.model)) return;
        const state = readState();
        if (state?.report) {
          setStatus(ctx, formatStatusline(ctx, state.report, isStale(state)), state.report);
          scheduleCountdown(ctx, state.report);
        }
        void refresh(ctx, false).catch(handleAsyncError);
      } catch (error) {
        handleError(error);
      }
    }, delay) as TimeoutHandle;
    countdownTimer.unref?.();
  };

  const isStale = (state: SharedState | undefined): boolean =>
    !!state?.updatedAt && Date.now() - state.updatedAt > 2 * config.refreshIntervalMs;

  const render = (ctx: ExtensionContext, force: boolean) => {
    if (!isActive(ctx.model)) {
      if (shownKey !== undefined) {
        shownKey = undefined;
        clearTimers();
        setStatus(ctx, undefined);
      }
      return;
    }
    const auth = resolveAuth();
    if (!auth) {
      const key = "no-auth";
      if (!force && shownKey === key) return;
      shownKey = key;
      clearTimers();
      setStatus(ctx, `${ctx.ui.theme.fg("muted", "TP")} ${ctx.ui.theme.fg("dim", "вход: /alibaba-usage login")}`);
      return;
    }
    const state = readState();
    if (state?.loginExpired) {
      const key = "login-expired";
      if (!force && shownKey === key) return;
      shownKey = key;
      clearTimers();
      setStatus(ctx, `${ctx.ui.theme.fg("muted", "TP")} ${ctx.ui.theme.fg("warning", "сессия истекла: /alibaba-usage login")}`);
      return;
    }
    const report =
      state?.report && state.updatedAt && Date.now() - state.updatedAt < STALE_REPORT_MAX_AGE_MS ? state.report : undefined;
    if (report) {
      const key = `report:${state?.updatedAt}:${isStale(state)}`;
      if (!force && shownKey === key) return;
      shownKey = key;
      setStatus(ctx, formatStatusline(ctx, report, isStale(state)), report);
      scheduleCountdown(ctx, report);
      return;
    }
    if (state?.error) {
      const key = `error:${state.error}`;
      if (!force && shownKey === key) return;
      shownKey = key;
      clearTimers();
      setStatus(ctx, `${ctx.ui.theme.fg("muted", "TP")} ${ctx.ui.theme.fg("dim", "n/a")}`);
      return;
    }
    const key = "loading";
    if (!force && shownKey === key) return;
    shownKey = key;
    setStatus(ctx, `${ctx.ui.theme.fg("muted", "TP")} ${ctx.ui.theme.fg("dim", "…")}`);
  };

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
    if (!isActive(ctx.model)) return;
    const auth = resolveAuth();
    if (!auth) {
      render(ctx, force);
      return;
    }
    if (inFlight) return inFlight;
    const state = readState();
    const now = Date.now();
    if (!force && (!isRefreshDue(state, instanceId, now) || now - lastAttemptAt < MIN_ATTEMPT_GAP_MS)) {
      render(ctx, force);
      return;
    }
    const promise = (async () => {
      if (!claimRefresh(instanceId)) return;
      lastAttemptAt = Date.now();
      currentTarget = await resolveConsoleTarget(ctx, config, auth);
      try {
        const report = await fetchUsageReport(auth.access_token, currentTarget.region, currentTarget.site);
        publishSuccess(report, config.refreshIntervalMs);
      } catch (error) {
        if (error instanceof UsageError) publishFailure(error, config.refreshIntervalMs);
        else publishFailure(new UsageError(error instanceof Error ? error.message : String(error), "error"), config.refreshIntervalMs);
      }
    })().finally(() => {
      if (inFlight === promise) inFlight = undefined;
    });
    inFlight = promise;
    await promise;
    render(ctx, force);
  };

  const tick = async (ctx: ExtensionContext) => {
    try {
      if (!isActive(ctx.model)) {
        render(ctx, false);
        return;
      }
      await refresh(ctx, false);
      const state = readState();
      const loading = shownKey === "loading";
      const dueAt = Math.max(state?.nextRetryAt ?? 0, lastAttemptAt + MIN_ATTEMPT_GAP_MS);
      const delay = loading ? MIN_TICK_MS : Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, dueAt - Date.now()));
      if (tickTimer) clearTimeout(tickTimer);
      tickTimer = setTimeout(() => void tick(ctx).catch(handleAsyncError), delay) as TimeoutHandle;
      tickTimer.unref?.();
    } catch (error) {
      handleError(error);
    }
  };

  const handleError = (error: unknown) => {
    if (isStaleCtx(error)) {
      clearTimers();
      return;
    }
    // Don't crash pi over a status failure; the error will be recorded in state on the next request.
  };
  const handleAsyncError = (error: unknown) => handleError(error);

  const kick = (ctx: ExtensionContext) => {
    config = loadConfig();
    clearTimers();
    shownKey = undefined;
    if (!isActive(ctx.model)) {
      setStatus(ctx, undefined);
      return;
    }
    render(ctx, true);
    void tick(ctx).catch(handleAsyncError);
  };

  // -- commands -------------------------------------------------------------

  const saveLogin = (payload: LoginResult, fallback: { region: string; site: ConsoleSite }) => {
    const auth: AuthStore = {
      access_token: payload.accessToken,
      console_site: payload.consoleSite ?? fallback.site,
      console_region: payload.consoleRegion ?? fallback.region,
      saved_at: Date.now(),
    };
    writeJsonAtomic(authPath, auth);
    // Clear past errors so the new token is tried immediately.
    const prev = readState();
    if (prev) writeJsonAtomic(statePath, { ...prev, error: undefined, loginExpired: false, unavailable: false, failures: 0, nextRetryAt: 0 });
  };

  const safeNotify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
    try {
      ctx.ui.notify(message, level);
    } catch (error) {
      if (!isStaleCtx(error)) throw error;
    }
  };

  /** Background login: the command handler does NOT await it, so pi doesn't hang. */
  const runLogin = async (ctx: ExtensionContext) => {
    loginInProgress = true;
    const controller = new AbortController();
    activeLogin = controller;
    try {
      const target = await resolveConsoleTarget(ctx, config, resolveAuth());
      const payload = await browserLogin(
        target.site,
        (url) => {
          safeNotify(
            ctx,
            `Открываю страницу входа. Если браузер не открылся, откройте вручную:\n${url}\n\n` +
              "Callback на 127.0.0.1 разрешают Chromium-браузеры (Chrome/Edge/Brave); Safari и Firefox блокируют. " +
              'Надпись "Login successful" в браузере не гарантирует доставку токена — ждите уведомления в pi.\n' +
              "Если вход не завершается, достаньте токен вручную: откройте консоль браузера (DevTools) на странице входа и выполните:\n" +
              `fetch("https://${target.site === "international" ? "bailian-singapore-cs.alibabacloud.com" : "bailian-cs.console.aliyun.com"}/cli/authorize",{method:"POST",credentials:"include"}).then(r=>r.json()).then(d=>copy(d.data.access_token))\n` +
              "(токен скопируется в буфер), затем: /alibaba-usage token <вставить>",
            "info",
          );
        },
        controller.signal,
      );
      saveLogin(payload, target);
      if (!isActive(ctx.model)) {
        safeNotify(ctx, `Console-токен сохранён. Статус квоты появится, когда активен провайдер ${config.provider}.`, "info");
        return;
      }
      safeNotify(ctx, "Console-токен сохранён. Обновляю квоту…", "info");
      await refresh(ctx, true);
      const state = readState();
      safeNotify(ctx, formatDetail(ctx, state, currentTarget.region, currentTarget.site), state?.report ? "info" : "warning");
      kick(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "вход отменён") safeNotify(ctx, "Вход отменён.", "info");
      else
        safeNotify(
          ctx,
          `Вход не удался: ${message}\nМожно импортировать токен вручную: /alibaba-usage token <токен> (однострочник для DevTools показывается при /alibaba-usage login).`,
          "error",
        );
    } finally {
      loginInProgress = false;
      if (activeLogin === controller) activeLogin = undefined;
    }
  };

  pi.registerCommand("alibaba-usage", {
    description: "Остаток квоты Alibaba Token Plan: /alibaba-usage [login|cancel|logout|refresh|token <t>]",
    handler: async (args, ctx) => {
      config = loadConfig();
      const trimmed = (args ?? "").trim();
      const [sub, ...rest] = trimmed.split(/\s+/);

      if (sub === "login") {
        if (loginInProgress) {
          ctx.ui.notify("Вход уже выполняется — завершите его в браузере или отмените: /alibaba-usage cancel", "warning");
          return;
        }
        void runLogin(ctx);
        return;
      }

      if (sub === "cancel") {
        if (activeLogin) {
          activeLogin.abort();
          ctx.ui.notify("Отменяю вход…", "info");
        } else {
          ctx.ui.notify("Нет активного входа.", "info");
        }
        return;
      }

      if (sub === "logout") {
        try {
          if (existsSync(authPath)) unlinkSync(authPath);
        } catch {
          /* ignore */
        }
        const prev = readState();
        if (prev) writeJsonAtomic(statePath, { ...prev, report: undefined, error: undefined, loginExpired: false, nextRetryAt: 0 });
        shownKey = undefined;
        render(ctx, true);
        ctx.ui.notify("Токен удалён. Собственный токен стёрт; токен из ~/.bailian (если есть) не тронут.", "info");
        return;
      }

      if (sub === "token") {
        const token = rest.join(" ").trim();
        if (!token || /\s/.test(token)) {
          ctx.ui.notify("Использование: /alibaba-usage token <console access token>", "warning");
          return;
        }
        const target = await resolveConsoleTarget(ctx, config, resolveAuth());
        saveLogin({ accessToken: token }, target);
        ctx.ui.notify("Токен сохранён. Обновляю квоту…", "info");
        await refresh(ctx, true);
        kick(ctx);
        return;
      }

      if (sub === "refresh") {
        await refresh(ctx, true);
        kick(ctx);
        return;
      }

      // Default: force refresh + detailed panel.
      const auth = resolveAuth();
      if (!auth) {
        ctx.ui.notify("Нет console-токена. Выполните /alibaba-usage login (вход через браузер).\nAPI-ключ sk-sp- для квоты не подходит — нужен именно console-вход.", "warning");
        return;
      }
      await refresh(ctx, true);
      const state = readState();
      const target = await resolveConsoleTarget(ctx, config, auth);
      ctx.ui.notify(formatDetail(ctx, state, target.region, target.site), state?.report ? "info" : "warning");
      kick(ctx);
    },
  });

  // -- events ---------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => kick(ctx));
  pi.on("session_tree", (_event, ctx) => kick(ctx));
  pi.on("model_select", (event, ctx) => {
    config = loadConfig();
    clearTimers();
    shownKey = undefined;
    if (!isActive(event.model)) {
      setStatus(ctx, undefined);
      return;
    }
    render(ctx, true);
    void tick(ctx).catch(handleAsyncError);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    activeLogin?.abort();
    clearTimers();
    stopFooterReady?.();
    setStatus(ctx, undefined);
  });
}
