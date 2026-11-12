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
    extension = (await import("../index.js")).default;
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
