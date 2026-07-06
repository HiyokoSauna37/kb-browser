# kb — CLI Browser

**A browser you operate entirely from the command line.** Built on Playwright + Chromium (CDP).

日本語版は [README.ja.md](README.ja.md) を参照してください。

Everything a GUI browser gives you — page rendering, cookie management, DevTools operations (Network / Console / Elements) — is available as `kb` commands. FoxyProxy-style proxy profiles are built in, with **restart-free switching** and per-host routing rules. Designed to be driven by AI agents (Claude Code, etc.) via Bash or MCP, while the window is a real Chrome you can use by hand at any time.

## Features

- **Daemon architecture** — the browser stays resident; every CLI command returns in tens of milliseconds
- **Real Chrome** — uses your installed Chrome/Edge (DRM works), falling back to bundled Chromium
- **DevTools from the terminal** — network log / request blocking / response mocking / HAR recording / console / DOM inspection
- **Proxy profiles** — save `host:port` (+auth) as named profiles, switch instantly without restarting the browser, route specific hosts through specific proxies (FoxyProxy-style rules), SOCKS5 auth handled by the built-in relay
- **Headed ⇄ headless** — switch modes; tabs and cookies survive
- **Human-in-the-loop** — the agent automates, you take over for logins/CAPTCHAs, `kb wait` detects when you're done
- **MCP server** — `kb-mcp` exposes 18 tools (screenshots are returned as images)
- **`--json` everywhere** — machine-readable output for scripting and agents

## Install

```bash
npm install
npm run build
npm link        # makes kb / kb-mcp available globally
```

The browser binary is auto-selected: installed Chrome → Edge → Playwright's bundled Chromium (run `npx playwright install chromium` only if you need the bundled one).

## Quick start

```bash
kb open example.com        # daemon (browser) auto-starts
kb text                    # read the page as text
kb screenshot -o s.png
kb daemon stop             # quit the browser
```

Headed (visible window) by default. Cookies and login state persist under `~/.kb/profiles/`.

## Commands

| Category | Commands |
|---|---|
| Daemon | `kb daemon start [--headless] / stop / status` |
| Pages | `kb open <url> [-n]` / `kb tabs [close/switch <id>]` / `kb text` / `kb html` / `kb screenshot [-f]` |
| Interaction | `kb click <sel>` / `kb fill <sel> <val>` / `kb press <key>` / `kb eval <js>` |
| Cookies | `kb cookies [list/set/clear]` |
| Network | `kb net log [-f] [--filter re]` / `kb net block <glob>` / `kb net mock <glob> --body f` / `kb net har start/stop` |
| Console | `kb console [-f]` |
| DOM | `kb dom query <sel> [--html] [--attr name]` |
| Proxy | `kb proxy add/rm/list/use/off/test` / `kb proxy rule add/rm/list` |
| Mode | `kb mode headed\|headless` (tabs & cookies restored) |
| Waiting | `kb wait [--url <glob>] [--selector <sel>]` |
| Emulation | `kb emulate ua/viewport/tz/geo/reset` |

All commands support `--json`.

## Proxy profiles (FoxyProxy-style)

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 --user u --pass p --bypass "*.internal"
kb proxy use work                              # applied instantly, no browser restart
kb proxy rule add "*.corp.example.com" work    # route only this host through work (first match wins)
kb proxy test                                  # verify via external IP + latency
```

How it works: Chromium always points at a local relay proxy inside the daemon; switching only swaps the relay's upstream. That's why no restart is needed, and why SOCKS5 authentication (which Chromium doesn't support natively) works — the relay handles it.

## Driving it from an AI agent

**Via Bash**: commands return fast thanks to the resident daemon. Read with `kb text`, look with `kb screenshot`, act with `kb click / fill`.

**Via MCP**:

```bash
claude mcp add kb -- kb-mcp
```

Exposes `kb_open`, `kb_text`, `kb_screenshot` (returns an image), `kb_eval`, `kb_click`, `kb_net_log`, `kb_proxy_use`, and more — 18 tools.

**Human-in-the-loop**: for logins or CAPTCHAs, the user just uses the window directly; the agent resumes after `kb wait --url "**dashboard**"` succeeds.

## Architecture

```
kb (CLI) ──HTTP+token──▶ daemon ── Playwright persistent context ──▶ Chrome/Edge/Chromium
kb-mcp (MCP stdio) ──┘      └─ local relay proxy ──▶ upstream proxies (profiles/rules)
```

State lives in `~/.kb/` (daemon.json / proxies.json / profiles/ / daemon.log).

## License

MIT
