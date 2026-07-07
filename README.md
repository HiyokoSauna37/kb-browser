# kb — CLI Browser

**A browser you operate entirely from the command line.** Built on Playwright + Chromium (CDP).

日本語版は [README.ja.md](README.ja.md) を参照してください。

Everything a GUI browser gives you — page rendering, cookie management, DevTools operations (Network / Console / Elements) — is available as `kb` commands. FoxyProxy-style proxy profiles are built in, with **restart-free switching** and per-host routing rules. Designed to be driven by AI agents (Claude Code, etc.) via Bash or MCP, while the window is a real Chrome you can use by hand at any time.

## Features

- **Daemon architecture** — the browser stays resident; every CLI command returns in tens of milliseconds
- **Real Chrome** — uses your installed Chrome/Edge (DRM works), falling back to bundled Chromium
- **Agent-optimized** — `kb snapshot` returns an accessibility tree with element refs; `kb click --ref e12` acts on them reliably (including inside iframes), and stale refs are **auto re-resolved** to the element with the same role/name after re-renders. Long outputs (text / html / snapshot) are capped at 20,000 chars by default with `--offset` paging. `kb eval` accepts `await` and multi-line code as-is
- **DevTools from the terminal** — network log / response bodies (`kb net body`) / request blocking / response mocking / HAR recording / console / DOM inspection
- **Mini REST client** — `kb request` hits APIs directly without opening a page; cookies and proxy settings are shared with the browser (call authenticated APIs as-is)
- **Proxy profiles** — save `host:port` (+auth) as named profiles, switch instantly without restarting the browser, route specific hosts through specific proxies (FoxyProxy-style rules), SOCKS5 auth handled by the built-in relay (the relay itself is token-protected)
- **Headed ⇄ headless / profile switching** — tabs and cookies survive
- **Persistent sign-in** — log in once and the state is kept in the profile across sessions; `kb login` wraps the manual sign-in flow in one command, `kb storage dump / restore` exports it to a file
- **Human-in-the-loop** — the agent automates, you take over for logins/CAPTCHAs, `kb wait` detects when you're done
- **MCP server** — `kb-mcp` exposes 22 tools (screenshots are returned as images)
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
kb snapshot                # page structure with element refs
kb click --ref e6          # click reliably by ref
kb screenshot -o s.png
kb daemon stop             # quit the browser
```

Headed (visible window) by default. Cookies and login state persist under `~/.kb/profiles/`.

## Commands

| Category | Commands |
|---|---|
| Daemon | `kb daemon start [--headless] [--profile <n>] / stop / status` |
| Pages | `kb open <url> [-n] [--wait idle]` / `kb tabs [close/switch <id>]` / `kb text` / `kb html` / `kb snapshot` / `kb screenshot [<sel>\|--ref e12] [-f] [--timeout <sec>]` (element-level supported) / `kb pdf` (headless only) |
| Navigation | `kb back` / `kb forward` / `kb reload` / `kb scroll [--to <sel>/--bottom]` |
| Interaction | `kb click` / `kb fill` / `kb select [--label]` / `kb check` / `kb uncheck` / `kb hover` / `kb upload <sel> <local file path...>` / `kb press <key>` / `kb eval <js> [--file f.js]` (`await` & multi-line OK; returns the last expression) — target via CSS selector, `--ref e12` (from snapshot), or `--frame <sel>` (inside iframe) |
| HTTP | `kb request <url> [-X POST] [-H "Name: value"] [-d body \| --data-file f] [-o file]` (page-independent; shares cookies & proxy with the browser) |
| Login | `kb login [url] [--until <glob>] [--save <file>]` (manual sign-in → state auto-saved to the profile) |
| Cookies / session | `kb cookies [list/get/set/rm/clear/export/import]` / `kb storage dump/restore` |
| Downloads | `kb downloads [list/clear]` (auto-saved under `~/.kb/downloads/`) |
| Network | `kb net log [-f] [--filter re]` / `kb net body <seq>` (response body) / `kb net block <glob>` / `kb net mock <glob> --body f` / `kb net har start/stop` |
| Console | `kb console [-f]` |
| DOM | `kb dom query <sel> [--html] [--attr name] [--frame <sel>]` |
| Proxy | `kb proxy add/rm/list/use/off/status/test` / `kb proxy rule add/rm/list` |
| Mode / profile | `kb mode headed\|headless` / `kb profile list/use <n>` (tabs & cookies restored) |
| Auth | `kb auth set <user> <pass>` / `kb auth clear` (HTTP Basic auth for target sites) |
| Waiting | `kb wait [--url <glob>] [--selector <sel>] [--idle] [--any]` (multiple conditions AND by default, `--any` for OR) |
| Emulation | `kb emulate ua/viewport/tz/geo/net/reset` (net: offline/slow3g/fast3g) |

All commands support `--json`. Long outputs are truncated at 20,000 chars by default; use `--offset <n>` for the next chunk or `--max-chars 0` for everything.

## Staying signed in

**Sign in once.** kb launches the browser with a persistent profile (`~/.kb/profiles/`), so cookies and localStorage survive daemon restarts. For the initial sign-in to a service, use `kb login`:

```bash
kb login github.com          # switches to headed, opens the page → sign in → press Enter
kb login myapp.example.com --until "**/dashboard**"   # auto-detect completion by URL (agent-friendly)
kb login github.com --save gh-state.json              # also back the state up to a file
```

Subsequent sessions start already signed in — nothing to do. A `--save`d file can be carried to another profile or machine with `kb storage restore <file>`.

Note: sites that rely purely on session cookies (no expiry) sign you out on browser restart, same as a regular browser. `kb storage dump / restore` covers that case too.

## API debugging

When your API returns something unexpected, read the body right away — no HAR recording needed:

```bash
kb net log --filter "api"    # note the #seq at the start of each line
kb net body 42               # print that response body (JSON reads as-is)
```

Bodies are captured automatically for text-like (JSON / HTML / JS / XML …) XHR / fetch / document responses. Capture is truncated at **256 KB per response** (32 MB / 500 entries total, oldest evicted first): `--offset` pages within the captured part, but anything beyond 256 KB is not recoverable afterwards — if you need the full body of a large response, re-fetch it with `kb request <url> -o <file>`.

To hit an endpoint directly, use `kb request` (a mini REST client):

```bash
kb request localhost:3000/api/users                    # GET
kb request localhost:3000/api/users -X POST \
  -H "Content-Type: application/json" -d '{"name":"a"}'
kb request api.example.com/v2/me -H "Accept: application/vnd.api+json" -H "X-Api-Version: 2"
```

No page needed, and **cookies & proxy settings are shared with the browser** — if you're logged in in the browser, authenticated APIs just work, and `Set-Cookie` responses flow back into the browser. Save binary responses with `-o <file>`.

## Proxy profiles (FoxyProxy-style)

```bash
kb proxy add work --type http --host 10.0.0.1 --port 8080 --user u --pass p --bypass "*.internal"
kb proxy use work                              # applied instantly, no browser restart
kb proxy rule add "*.corp.example.com" work    # route only this host through work (first match wins)
kb proxy test                                  # verify via external IP + latency
kb proxy status                                # what the daemon is actually using
```

How it works: Chromium always points at a local relay proxy inside the daemon; switching only swaps the relay's upstream. That's why no restart is needed, and why SOCKS5 authentication (which Chromium doesn't support natively) works — the relay handles it. The relay itself requires a per-session token, so other local processes can't ride it.

Common upstream setups:

```bash
# Working behind a corporate proxy (with auth, internal hosts direct)
kb proxy add corp --type http --host proxy.corp.example.com --port 8080 \
  --user myuser --pass mypass --bypass "*.internal,localhost"
kb proxy use corp

# Developing through a local mitmproxy / mock server
kb proxy add local --type http --host 127.0.0.1 --port 8081
kb proxy use local     # applied instantly, no restart
kb proxy off           # back to direct (also instant)
```

## Driving it from an AI agent

**From Claude Code, MCP is the recommended way** — native tools, no Bash output parsing:

```bash
claude mcp add kb -- kb-mcp
```

Exposes `kb_snapshot`, `kb_open`, `kb_text`, `kb_screenshot` (returns an image), `kb_click`, `kb_fill`, `kb_select`, `kb_eval`, `kb_request`, `kb_net_log`, `kb_net_body`, `kb_proxy_use`, and more — 22 tools.

**Via Bash** everything is available too (every command supports `--json`, with symmetric `{ok:true,result}` / `{ok:false,error}`). The recommended loop:

```bash
kb open example.com --wait idle   # use idle for SPAs
kb snapshot                       # discover elements with refs
kb click --ref e12                # act (returns the resulting URL/title)
kb text                           # read the outcome
```

**One-shot actions to cut round-trips**: when the target is identifiable by text, skip the snapshot — Playwright's selector engines work directly:

```bash
kb click "text=Save"                       # text match in one command
kb click "role=button[name='Save']"        # role + accessible name
```

With refs, a ref that went stale after a re-render is auto re-resolved to the element with the same role/name, so you only re-snapshot on failure.

**Human-in-the-loop**: for logins or CAPTCHAs, the user just uses the window directly; the agent resumes after `kb wait --url "**dashboard**"` succeeds. The initial sign-in flow is packaged as `kb login`.

## Architecture

```
kb (CLI) ──HTTP+token──▶ daemon ── Playwright persistent context ──▶ Chrome/Edge/Chromium
kb-mcp (MCP stdio) ──┘      └─ local relay proxy (token auth) ──▶ upstream proxies (profiles/rules)
```

State lives in `~/.kb/` (daemon.json / proxies.json / profiles/ / downloads/ / daemon.log).

## Development

```bash
npm test    # build + unit tests (node:test)
```

## License

MIT
