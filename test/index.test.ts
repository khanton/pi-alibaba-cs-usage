import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/test-home/.pi/agent",
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:os", () => ({ homedir: () => "/test-home" }));

let mod: typeof import("../index.js");
let extension: (typeof import("../index.js"))["default"];

function makePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const stopFooterReady = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def);
    }),
    events: { emit: vi.fn(), on: vi.fn(() => stopFooterReady) },
  };
  return { pi, handlers, commands, stopFooterReady };
}

function makeCtx(provider = "alibaba-plan") {
  return {
    model: { provider },
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
      },
    },
    modelRegistry: { getProviderAuth: vi.fn(async () => undefined) },
  };
}

describe("pi-alibaba-cs-usage extension", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("BAILIAN_CONSOLE_TOKEN", "");
    extension = (mod = await import("../index.js")).default;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("registers the command and lifecycle handlers", () => {
    const { pi, handlers, commands } = makePi();
    extension(pi as never);

    expect(commands.has("alibaba-usage")).toBe(true);
    for (const event of ["session_start", "session_tree", "model_select", "session_shutdown"]) {
      expect(handlers.has(event)).toBe(true);
    }
  });

  it("clears the status when the configured provider is not active", () => {
    const { pi, handlers } = makePi();
    extension(pi as never);
    const ctx = makeCtx("some-other-provider");

    handlers.get("session_start")!({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("alibaba-usage", undefined);
  });

  it("prompts for login when the provider is active but no console token exists", () => {
    const { pi, handlers } = makePi();
    extension(pi as never);
    const ctx = makeCtx();

    handlers.get("session_start")!({}, ctx);

    const text = ctx.ui.setStatus.mock.calls.at(-1)?.[1];
    expect(text).toContain("/alibaba-usage login");
    expect(text.startsWith("alibaba ")).toBe(true);
    expect(text).not.toContain("TP");
  });

  it("clears the status and stops the footer subscription on shutdown", () => {
    const { pi, handlers, stopFooterReady } = makePi();
    extension(pi as never);
    const ctx = makeCtx();

    handlers.get("session_shutdown")!({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("alibaba-usage", undefined);
    expect(stopFooterReady).toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("pi-fancy-footer:widget", {
      protocol: 1,
      type: "remove",
      id: "alibaba.usage",
    });
  });

  it("reports when there is no login to cancel", async () => {
    const { pi, commands } = makePi();
    extension(pi as never);
    const ctx = makeCtx();

    await commands.get("alibaba-usage")!.handler("cancel", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Нет активного входа.", "info");
  });

  it("rejects an empty manual token", async () => {
    const { pi, commands } = makePi();
    extension(pi as never);
    const ctx = makeCtx();

    await commands.get("alibaba-usage")!.handler("token", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Использование: /alibaba-usage token <console access token>", "warning");
  });
});

describe("weekly/monthly days-left display", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = 1_000_000_000_000;
  const win = (key: string, label: string, durationHours: number, usedPercent: number, resetAt?: number) => ({
    key,
    label,
    durationHours,
    usedPercent,
    resetAt,
  });

  it("isLongWindow detects week/month but not hour/day", () => {
    expect(mod.isLongWindow(win("per1Week", "1w", 168, 10))).toBe(true);
    expect(mod.isLongWindow(win("per1Month", "1mo", 720, 10))).toBe(true);
    expect(mod.isLongWindow(win("per5Hour", "5h", 5, 10))).toBe(false);
    expect(mod.isLongWindow(win("per1Day", "1d", 24, 10))).toBe(false);
  });

  it("formatDaysLeft shows whole days, falls back under a day, 'now' when past", () => {
    expect(mod.formatDaysLeft(now + 6 * DAY + 3 * HOUR, now)).toBe("6d");
    expect(mod.formatDaysLeft(now + 25 * DAY, now)).toBe("25d");
    expect(mod.formatDaysLeft(now + 5 * HOUR, now)).toBe("5h");
    expect(mod.formatDaysLeft(now - HOUR, now)).toBe("now");
  });

  it("statusCountdown uses '· Nd' for the weekly window", () => {
    const primary = win("per5Hour", "5h", 5, 40, now + 2 * HOUR);
    const secondary = win("per1Week", "1w", 168, 10, now + 6 * DAY + 3 * HOUR);
    expect(mod.statusCountdown(primary, secondary, now)).toBe("· 6d");
  });

  it("statusCountdown keeps the h/m countdown for a short-only report", () => {
    const primary = win("per5Hour", "5h", 5, 40, now + 2 * HOUR);
    expect(mod.statusCountdown(primary, undefined, now)).toBe("2h");
  });

  it("statusCountdown shows primary reset · weekly days when primary is exhausted", () => {
    const primary = win("per5Hour", "5h", 5, 100, now + 2 * HOUR);
    const secondary = win("per1Week", "1w", 168, 10, now + 6 * DAY + 3 * HOUR);
    expect(mod.statusCountdown(primary, secondary, now)).toBe("2h · 6d");
  });

  it("footer widget always shows '· Nd' for weekly, even below the reset threshold", () => {
    const report = {
      fetchedAt: now,
      windows: [
        win("per5Hour", "5h", 5, 45, now + 2 * HOUR),
        win("per1Week", "1w", 168, 10, now + 6 * DAY + 3 * HOUR),
      ],
    };
    const widget = mod.buildFooterWidget(report, now);
    expect(widget.content.text).toContain("1w");
    expect(widget.content.text).toContain("· 6d");
    // 5h at 45% is below the 75% threshold -> no '~reset' shown for the short window.
    expect(widget.content.text).not.toContain("~");
  });
});

describe("built-in status line (without pi-fancy-footer)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = 1_000_000_000_000;
  const BAR_GLYPHS = "⠀▘▝▖▌▞▛▗▚▐▜▄▙▟█";
  const win = (key: string, label: string, durationHours: number, usedPercent: number, resetAt?: number) => ({
    key,
    label,
    durationHours,
    usedPercent,
    resetAt,
  });
  const report = (windows: ReturnType<typeof win>[]) => ({ windows, fetchedAt: now });
  const twoWindows = report([
    win("per5Hour", "5h", 5, 40, now + 2 * HOUR),
    win("per1Week", "1w", 168, 10, now + 6 * DAY + 3 * HOUR),
  ]);

  beforeEach(() => {
    vi.setSystemTime(now);
  });

  it("is prefixed with 'alibaba' and labels each bar with its quota window", () => {
    const text = mod.formatStatusline(makeCtx() as never, twoWindows, false);
    expect(text).toBe("alibaba 5h ███⠀⠀ 1w ████▌ · 6d");
    expect(text).not.toContain("TP");
  });

  it("draws a narrow 5-cell bar per window and keeps the rest in the panel", () => {
    const text = mod.formatStatusline(
      makeCtx() as never,
      report([...twoWindows.windows, win("per1Month", "1mo", 720, 30, now + 9 * DAY)]),
      false,
    );
    expect([...text].filter((ch) => BAR_GLYPHS.includes(ch))).toHaveLength(2 * 5);
    expect(text).not.toContain("1mo");
  });

  it("fills the bar proportionally to the remaining quota", () => {
    const bar = (usedPercent: number) => mod.formatSingleLimitBar(win("per5Hour", "5h", 5, usedPercent));
    expect(bar(0)).toBe("█".repeat(5));
    expect(bar(50)).toBe("██▌⠀⠀");
    expect(bar(100)).toBe("⠀".repeat(5));
    expect(mod.formatSingleLimitBar(win("per5Hour", "5h", 5, 0), 3)).toBe("███");
  });

  it("renders a single window with its own label and countdown", () => {
    const text = mod.formatStatusline(makeCtx() as never, report([win("per5Hour", "5h", 5, 40, now + 2 * HOUR)]), false);
    expect(text).toBe("alibaba 5h ███⠀⠀ 2h");
  });

  it("uses the same plan labels as the footer widget for day/month windows", () => {
    const text = mod.formatStatusline(
      makeCtx() as never,
      report([win("per1Day", "1d", 24, 20, now + 20 * HOUR), win("per1Month", "1mo", 720, 30, now + 9 * DAY)]),
      false,
    );
    expect(text).toContain("1d ");
    expect(text).toContain("1mo ");
    expect(text).toContain("· 9d");
  });

  it("highlights an exhausted window and keeps both reset countdowns", () => {
    const backgrounds: string[] = [];
    const ctx = makeCtx();
    ctx.ui.theme.bg = (color: string, text: string) => {
      backgrounds.push(color);
      return text;
    };
    const text = mod.formatStatusline(
      ctx as never,
      report([win("per5Hour", "5h", 5, 100, now + 2 * HOUR), win("per1Week", "1w", 168, 10, now + 6 * DAY)]),
      false,
    );
    expect(backgrounds).toEqual(["toolErrorBg", "userMessageBg"]);
    expect(text).toContain(`5h ${"⠀".repeat(5)}`);
    expect(text).toContain("2h · 6d");
  });

  it("marks stale data and reports missing windows", () => {
    expect(mod.formatStatusline(makeCtx() as never, twoWindows, true).endsWith("· устарело")).toBe(true);
    expect(mod.formatStatusline(makeCtx() as never, report([]), false)).toBe("alibaba n/a");
  });
});
