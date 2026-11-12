# pi-alibaba-cs-usage

A [pi](https://github.com/earendil-works/pi) extension that shows the remaining Alibaba Cloud Model Studio Token Plan quota in pi's status line.

## What it does

Displays the remaining quota per window (5h / weekly / monthly) and the time until the next reset. Data comes from the official Bailian console gateway (the same protocol as the `bl usage token-plan` CLI), without depending on the CLI itself.

- Compact braille bar in the status line: the left half of each cell is the nearest quota window (5h), the right half is the next one (weekly), plus a countdown to reset. The monthly window stays in the detailed panel.
- The status is shown only while the active model's provider matches the configured one (default `alibaba-plan`).
- Optional widget for pi-fancy-footer via the pi event bus — no hard dependency; without the footer the status stays in pi's built-in status line.
- Multiple pi instances share one cache and one refresh leader (claim lock + exponential backoff), so the gateway is not hammered.

## Requirements

- **pi** coding agent
- An Alibaba Cloud Model Studio **Token Plan** subscription
- A **console token** — an `sk-sp-` API key does not work for this gateway. Run `/alibaba-usage login` (a Chromium-based browser is preferred: Safari and Firefox block the 127.0.0.1 callback).

Token sources, in order of precedence:

1. `BAILIAN_CONSOLE_TOKEN` environment variable
2. Own store: `~/.pi/agent/alibaba-usage/auth.json` (written by `/alibaba-usage login` or `token`)
3. Bailian CLI: `~/.bailian/config.json` (if `bl auth login --console` has been run)

## Installation

### As a pi package

```bash
pi install git:github.com/khanton/pi-alibaba-cs-usage
# or
pi install https://github.com/khanton/pi-alibaba-cs-usage.git
```

### Manual installation

Copy or symlink into pi's extensions directory:

```bash
# Global
cp -r . ~/.pi/agent/extensions/pi-alibaba-cs-usage

# Or per-project
cp -r . .pi/extensions/pi-alibaba-cs-usage
```

### Quick test

```bash
pi -e ./index.ts
```

## Commands

| Command | Description |
|---|---|
| `/alibaba-usage` | Detailed panel + forced refresh |
| `/alibaba-usage login` | Browser login (does not block pi) |
| `/alibaba-usage cancel` | Cancel a pending login |
| `/alibaba-usage refresh` | Refresh only |
| `/alibaba-usage logout` | Delete the saved token |
| `/alibaba-usage token <token>` | Import a token manually (if the browser cannot reach 127.0.0.1) |

## Configuration

Optional: `~/.pi/agent/alibaba-usage/config.json`

```json
{
  "provider": "alibaba-plan",
  "refreshIntervalMs": 300000,
  "consoleRegion": "ap-southeast-1",
  "consoleSite": "international",
  "enabled": true
}
```

- `provider` — pi provider to show status for
- `refreshIntervalMs` — refresh interval (minimum 30 s, default 5 minutes)
- `consoleRegion` / `consoleSite` — forced region/site (otherwise auto-detected from the provider's base URL)
- `enabled` — set `false` to disable the extension

State files: `~/.pi/agent/alibaba-usage/{auth.json,state.json}` (permissions 0600/0700).

## Development

```bash
npm install
npm run check
npm test
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
