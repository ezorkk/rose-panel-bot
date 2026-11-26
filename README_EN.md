<div align="center">

<img src="docs/assets/banner.svg" alt="RosePanel Bot Banner" width="100%" />

<br />

[![Release](https://flat.badgen.net/github/tag/mango0114/rose-panel-bot?color=A32952&label=Release)](https://github.com/mango0114/rose-panel-bot/releases)
[![Stars](https://flat.badgen.net/github/stars/mango0114/rose-panel-bot?color=E56B92&label=Stars)](https://github.com/mango0114/rose-panel-bot/stargazers)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-%40Rose202__bot-C93B6B?logo=telegram&logoColor=white&style=flat-square)](https://t.me/Rose202_bot)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white&style=flat-square)](https://workers.cloudflare.com/)
[![Telegram Mini App](https://img.shields.io/badge/Telegram-Mini%20App-26A5E4?logo=telegram&logoColor=white&style=flat-square)](https://core.telegram.org/bots/webapps)
[![License: MIT](https://img.shields.io/badge/License-MIT-A32952?style=flat-square)](LICENSE)

<p>
  <a href="README.md">🇨🇳 简体中文</a> ·
  <b>🇺🇸 English</b> ·
  <a href="docs/SETUP_GUIDE.md">🐣 5-Min Guide (ZH)</a> ·
  <a href="AGENTS.md">🤖 AI Auto-Deploy</a> ·
  <a href="CHANGELOG.md">📋 Changelog</a> ·
  <a href="https://t.me/Rose202_bot">💬 Live Demo</a> ·
  <a href="#-support--sponsors">🧧 Sponsors</a>
</p>

<sub><b>Zero-group Anti-Spam Telegram PM Bot where you chat, view stickers & send photos right inside the panel</b> — In-Panel Replies/Photos/Stickers & Recall · Bidirectional Emoji Reaction Sync · 4-Layer Shield + 4 Verification Modes (incl. animated sticker quizzes) · Custom Auto-Reply · Includes a <b>0.2-Second Personal Panel</b> (Shareable QR Poster & Referral Tracking / Modular Probe with Offline Alerts / Site Bookmarks / Pixel Day-Night Slider) on Cloudflare Workers Free Tier</sub>

</div>

> - **🔄 Fork First for 1-Click Updates (Important)**: **Always click `Fork` at the top right before importing into Cloudflare Workers** — only Fork-based deployments support **1-click in-panel Fork sync updates** (100% KV data preserved). Release checks work for every deployment, but standalone copies have no GitHub `Sync fork` and must merge upstream manually (see the guide's FAQ).
> - **🔒 Zero Data Collection Promise**: Zero third-party relays — your Bot Token, config, sites, and visitor archive live **100% inside your own Cloudflare Workers & KV** (external calls occur only when enabled for read-only CAS, CF Turnstile, or public GitHub Release checks).
> - **🧭 Quick Links**: [🚀 4 Deployment Options (Fork / AI / CLI / VPS)](#-fast-deployment-free-in-5-minutes) · [🔄 Safe Upgrade Guide](#-upgrading-existing-deployments-100-kv-data-preserved) · [🐣 5-Min Guide (ZH)](docs/SETUP_GUIDE.md)

---

## 🎬 Live Motion Showcase (3 Real-App Clips)

### 1 · Direct In-Panel Chat & Phone Album Photo Replies

<div align="center">
  <img src="docs/assets/demo-chat.webp" alt="Direct in-panel chat, album photo upload, and Forum Topic sync" width="94%" />
</div>

- Tap **`💬 聊过` (Chat)** on any visitor card to view the last 60 two-way bubbles, **type text, pick any photo from your phone album (JPG / PNG / WebP / GIF, up to 10 MB), view signed static/video/Lottie stickers directly inside the chat, and recall messages in 1 tap**;
- **Works out-of-the-box without a group**: set `ADMIN_IDS` for Bot DM direct push (quote-reply to respond), or send `/bind` in a private Topics group anytime to switch into per-visitor Forum Topics (`/del` recalls from topics); **syncs emoji reactions bidirectionally** between visitor PMs and admin inbox, while photos & links auto-archive by sender (`Visitor` / `Me`).

### 2 · First-Time Stranger `/start` Sticker Quiz (Auto-Switch on Wrong Tap)

<div align="center">
  <img src="docs/assets/demo-verify.webp" alt="Stranger /start animated sticker verification, wrong-answer quiz switch, and auto-reply" width="94%" />
</div>

- Saving your welcome text auto-syncs Telegram's pre-Start intro box; strangers tapping **Start** (`/start`) get challenged immediately — send `/add` in PM (or pull any sticker pack inside Settings) to turn **static or animated stickers** into visual quizzes in 3 seconds;
- **Reshuffle on error**: multi-quiz banks immediately switch to another sticker (single-quiz banks re-randomize button order) with a script-trap decoy; passing grants 1–3650 days of direct PM access with optional **auto-reply & up to 50 keyword rules**.

### 3 · 0.2-Second Personal Panel & 224×84 Pixel Day/Night Bubble Slider

<div align="center">
  <img src="docs/assets/demo-panel.webp" alt="Photo archive, live multi-protocol probe refresh, private sites, and 224x84 pixel Day/Night slider" width="94%" />
</div>

- **224×84 Pixel Day/Night Bubble Slider**: scrub the crystal magnifier to toggle **Dark / Follow Telegram / Light** with a full-screen circular View Transition ripple synced to Telegram chrome; edge-injected splash + local SWR cache open in 0.2s, with **customizable bottom navigation order & default landing tab** (auto-skipping tabs hidden from guests while preserving deep links) and an automatic **What's New** modal after upgrades;
- Filter exchanged photos by sender; inspect live **Komari / Nezha (v1·v0) / NodeGet / Generic JSON** server metrics (with optional offline & resource alerts, off by default) and **Public / 🔒 Private** site bookmarks; generate **light/dark shareable QR card posters with Open Graph previews, `src_` referral tracking, and monthly unique visitor counts**; swap animated `.webp` / `.webm` / `.tgs` emblems via `/set` with 3-way private avatar options.

---

## 💬 More Highlights: Share Poster · `/add` Quizzes · `/set` Animated Emblems · 1-Click Fork Sync

<div align="center">
  <p><b>🪪 One-Tap Light & Dark QR Share Posters · Long-Press Save / Native Share / Copy Link</b></p>
  <img src="docs/assets/showcase-share.png" alt="Light and dark rose-porcelain QR card share posters" width="96%" />
  <br /><br />
  <p><b>🎭 3-Second Sticker Quizzes via <code>/add</code> · Full Visual Anti-Spam Controls</b></p>
  <img src="docs/assets/showcase-antispam.png" alt="Send any static or animated TG sticker via /add to create custom visual anti-spam quizzes" width="96%" />
  <br /><br />
  <p><b>✨ Animated Sticker Emblems via <code>/set</code> · Saved Collection & 0ms Edge Splash</b></p>
  <img src="docs/assets/showcase-badges.png" alt="Send /set with any sticker or custom emoji to update the animated main emblem" width="96%" />
  <br /><br />
  <p><b>🔄 Fork Deploy · In-App Update Check & Feedback · 1-Click Fork Sync (100% Data Preserved)</b></p>
  <img src="docs/assets/showcase-updater.png" alt="In-panel update check, feedback entry, and one-click Fork sync for Cloudflare deployments" width="96%" />
</div>

<details>
<summary><b>📱 Expand 4-Tab Retina Static Mini App Gallery (Card · Sites · Probe · Dark Theme)</b></summary>

<br />
<div align="center">
  <p><b>🪪 1 · Personal Card & Direct PM Wake-Up　｜　🌐 2 · Public & Private Dual-Layer Sites</b></p>
  <img src="docs/assets/preview-row1.png" alt="1 Personal Card & Contact Etiquette · 2 Public & Private Sites" width="96%" />
  <br /><br />
  <p><b>📡 3 · Multi-Protocol Probe　｜　🛡️ 4 · 4-Layer Anti-Spam & Visitor List</b></p>
  <img src="docs/assets/preview-row2.png" alt="3 Multi-Protocol Server Probe (Komari / Nezha / NodeGet / JSON) · 4 Visitors & 4-Layer Anti-Spam Shield" width="96%" />
  <br /><br />
  <p><b>🌙 Dark Rose-Obsidian Theme　｜　🖼️ Exchanged Photos Gallery & Link Archive (Filtered by Sender)</b></p>
  <img src="docs/assets/preview-row3.png" alt="Dark Rose-Obsidian Theme & Exchanged Photos Gallery" width="96%" />
</div>
</details>

---

## 🛡️ 4-Layer Anti-Spam Architecture & 4 Verification Modes

```mermaid
flowchart LR
  U["Stranger PMs Bot"] --> L1{"Layer 1 · CAS Global Blacklist"}
  L1 -- "Known Spammer" --> DROP["🚫 Silent Drop & Logged"]
  L1 -- "Clean User" --> L2{"Layer 2 · Risk & De-Obfuscation"}
  L2 -- "Banned Keyword / Edit Bypass" --> DROP
  L2 -- "Ad Flyer / Forward / URL / Spam Bio" --> TS["🛡️ Auto-Escalate to CF Turnstile"]
  L2 -- "Normal Message" --> CH["🎭 Sticker Quiz / 🎯 Emoji Pick"]
  CH -- "Trap / Repeated Fail" --> COOL["⏳ Cooldown Lock (or Instant Ban)"]
  CH -- "Passed (Custom Grace Days)" --> INBOX["💬 Forward to Forum Topic + Mini App Archive"]
  TS -- "Verified" --> INBOX
```

Switch anytime inside **⚙️ Settings → 防骚扰验证 (Anti-Spam Verification)** (or disable verification for direct forwarding), with visual controls for **New Visitor Probation** (holds links, `@username` mentions, contact info, or forwarded messages from newly verified visitors for silent admin approval/ban with domain allowlists and ordered replay — zero message loss) and **6 grouped ad-phrase blocked keyword presets** (all off by default, toggle per phrase or add by group):

| Mode | Experience & Mechanism | Anti-Abuse Protection |
| :--- | :--- | :--- |
| **🎭 Custom Sticker Quiz (Recommended)** | Use `/add` or the in-panel sticker pack picker to turn animated/static stickers into visual quizzes — **1s for humans** | Reshuffle on error (switches stickers in multi-quiz banks, re-randomizes button positions in single-quiz banks); auto-cleans sticker + honeypot & cooldown |
| **🎯 Emoji Odd-One-Out / Pick (Default)** | 3×3 pure-icon inline grid alternating odd-one-out and semantic pick — **zero latency** | Reshuffles on first mistake; consecutive failures trigger silent cooldown (configurable) |
| **📝 Local Quiz** | 2×2 local commonsense buttons, zero external calls | New question with reshuffled options on error + honeypot + silent cooldown |
| **🛡️ CF Turnstile Strict Mode** | 1-tap escalation during raids; native Cloudflare Turnstile inside Telegram WebApp with server-side `siteverify` | Auto-falls back to Emoji mode if Turnstile keys aren't set |

- **Security & Performance**: Full Telegram `initData` HMAC-SHA256 verification; `<0.1ms` in-memory admin auth + single-key overview cache (2 KV reads, 0 `KV.list` on normal load); `BOT_TOKEN` never touches the frontend.

---

## 🧩 Modular Add-Ons

Unused modules stay completely hidden and add zero overhead:

| Module | Default | Activation | Notes |
| :--- | :---: | :--- | :--- |
| **🪪 Personal Card + 🌐 Public/Private Sites** | Core | `BOT_TOKEN` + `TOPIC_MAP` KV | 0.2s panel with pixel Day/Night slider, animated emblems, dual-layer sites, shareable QR poster, Open Graph link previews, `src_<channel>` referral tracking, per-user monthly visitor count (admin-only by default; fail-open if Cloudflare KV's ~500 new visitors/day free write quota is exceeded, never blocking card loads), and a visitor-only footer signature with a "Want one?" deployment guide (toggleable off anytime in Settings) |
| **👤 Bidirectional PM Bot + 4-Layer Shield** | Optional | Works with `ADMIN_IDS` (Bot DM push), or `/bind` in a Topics group (optional, recommended for high volume) | Ready out-of-the-box via Bot DM push (quote-reply to respond), direct in-panel chat/photos & signed sticker rendering, bidirectional emoji reaction sync (in Topics mode, adds 1 KV write per visitor message for a 30-day `tmsg:*` reverse map), archive, CAS & sticker quizzes; `/bind` switches automatically to per-visitor Forum Topics |
| **📡 Pluggable Server Probe** | Optional | Pick provider & URL in Mini App | **Komari / Nezha (v1·v0) / NodeGet / Generic JSON**; Admin-Only toggle & optional offline/resource alerts (off by default) |
| **🛡️ CF Turnstile Strict Mode** | Optional | `TURNSTILE_SITE_KEY` & `SECRET` | Auto-escalates high-risk ads or toggle manually in Settings |
| **🌸 Group Check-in, Points & Badges** | Optional | `ENABLE_CHECKIN="true"` or in-app switch | Off by default for personal cards; 1-click on for group communities |

---

## 🚀 Fast Deployment (Free in 5 Minutes)

> **🐣 First Telegram bot?** Follow the **[5-Minute Beginner Guide (ZH)](docs/SETUP_GUIDE.md)** — from getting your first token from `@BotFather` to sending `/bind` in your group.

### Option 1: Fork + Cloudflare Web Deploy (Recommended ★ · Supports 1-Click In-Panel Updates)

1. Click **Fork** at the top right to copy `rose-panel-bot` into your own GitHub account.
2. Open Cloudflare Dashboard → **Workers & Pages → Create → Workers → Import a repository** and select your fork:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
3. In **Settings → Variables & Bindings**, confirm `TOPIC_MAP` KV is bound and add 4 core variables:
   - `BOT_TOKEN` (**Secret**) · `WEBHOOK_SECRET` (**Secret**, any random string)
   - `ADMIN_IDS` (**must be a Text variable, not Secret** — your numeric UID) · `BOT_USERNAME` (**Text**, without `@`)
4. Visit `https://<your-worker-domain>/setup?secret=<WEBHOOK_SECRET>` once until you see `"ok": true`, then send `/start` to your bot in PM — **Bot DM push + 4-layer anti-spam work immediately** with `ADMIN_IDS` (no group required!). *(Optional, recommended for high-volume inboxes)* Create a private group with **Topics** enabled, add the bot as Administrator, and send **`/bind`** to auto-switch into per-visitor Forum Topics!
5. *(Recommended)* In `@BotFather`, send `/newapp` with URL `https://<your-worker-domain>/` and a short name matching `APP_SHORT_NAME` (e.g. `panel`) so the panel opens cleanly from groups and topic buttons.

> 💡 **Why Fork instead of a 1-click template button?** Standalone template copies aren't GitHub Forks, so GitHub `Sync fork` and in-panel 1-click Fork sync won't work on them. Forking first takes 1 click and unlocks effortless future upgrades.

### Option 2: AI-Guided Modular Deploy (Antigravity / Claude Code / Codex / Cursor)

Open this repository (includes [AGENTS.md](AGENTS.md)) and ask your AI assistant:

```text
Read AGENTS.md in this repo, ask me which modules I want (or if I prefer a lightweight install), and guide me through deploying RosePanel Bot.
```

### Option 3: 5-Line Terminal Quickstart (macOS / Windows / Linux — Zero Dashboard Clicking)

```bash
# 1. Clone & install dependencies (Node.js 20+)
git clone https://github.com/mango0114/rose-panel-bot.git && cd rose-panel-bot && npm ci

# 2. Login & deploy (Wrangler v4 auto-provisions TOPIC_MAP KV)
npx wrangler login
npm run build && npx wrangler deploy --var ADMIN_IDS:YOUR_NUMERIC_UID --var BOT_USERNAME:YOUR_BOT_USERNAME

# 3. Set the 2 secrets interactively
npx wrangler secret put BOT_TOKEN && npx wrangler secret put WEBHOOK_SECRET

# 4. Register webhook & bot menu (expect {"ok":true,...}; then send /bind in your Topics group)
curl -s "https://<your-worker-domain>/setup?secret=<YOUR_WEBHOOK_SECRET>"
```

<details>
<summary><b>🛠️ Expand Windows / macOS Git & Node.js Install Commands</b></summary>

- **Windows (PowerShell)**: `winget install --id Git.Git -e && winget install --id OpenJS.NodeJS.LTS -e`
- **macOS (Terminal)**: `brew install git node`
</details>

### Option 4: Linux VPS / Docker / Self-Hosted

<details>
<summary><b>🐧 Expand Linux Prerequisites, Headless Deploy, Docker & Self-Hosted Caddy Guide</b></summary>

#### 1. Install Git & Node.js 22
- **Debian / Ubuntu**: `sudo apt update && sudo apt install -y curl git ca-certificates && curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
- **CentOS / Rocky / Alma**: `sudo dnf install -y curl git && curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs`
- **Arch**: `sudo pacman -Syu --noconfirm git nodejs npm` | **Alpine**: `apk add --no-cache git nodejs npm`

#### 2. Headless VPS Deploy to Cloudflare Workers
```bash
git clone https://github.com/mango0114/rose-panel-bot.git && cd rose-panel-bot && npm ci
export CLOUDFLARE_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN"
npm run build && npx wrangler deploy --var ADMIN_IDS:YOUR_NUMERIC_UID --var BOT_USERNAME:YOUR_BOT_USERNAME
echo "YOUR_BOT_TOKEN" | npx wrangler secret put BOT_TOKEN
echo "YOUR_RANDOM_SECRET" | npx wrangler secret put WEBHOOK_SECRET
curl -s "https://<your-worker-domain>/setup?secret=<YOUR_RANDOM_SECRET>"
```

#### 3. One-Line Docker Deploy
```bash
git clone https://github.com/mango0114/rose-panel-bot.git && cd rose-panel-bot
docker run --rm -it -v "$PWD":/app -w /app -e CLOUDFLARE_API_TOKEN="YOUR_API_TOKEN" node:22-alpine \
  sh -c "npm ci && npm run build && npx wrangler deploy --var ADMIN_IDS:YOUR_NUMERIC_UID --var BOT_USERNAME:YOUR_BOT_USERNAME"
```

#### 4. Self-Host on Your Own VPS (with Caddy HTTPS)
```bash
npm ci && npm run build && cp .dev.vars.example .dev.vars
# Edit .dev.vars with your real credentials (keep DEV_PREVIEW="false" in production)
npx wrangler dev --ip 127.0.0.1 --port 8787 --persist-to ./.wrangler/state --show-interactive-dev-session=false
```
Then reverse-proxy `127.0.0.1:8787` with Caddy for automatic HTTPS.
</details>

---

## 🔄 Upgrading Existing Deployments (100% KV Data Preserved)

> **✅ Never touch your Cloudflare KV!** Upgrading only replaces Worker code (`wrangler.toml` enables `keep_vars = true` so plain-text vars stay safe across deploys). Your card, sites, probe, visitors, and group binding stay **100% intact**. ⚠️ Do not create a new Worker or re-click a 1-click deploy button.

- **🔀 GitHub Fork Users (Easiest)**: Open **⚙️ Settings → 版本更新** in the Mini App, tap **检查新版本**; after filling **我 Fork 的 GitHub 仓库** (your fork's repo, e.g. `yourname/rose-panel-bot`), use **前往我的 Fork 点 Sync fork** (no token needed), or add a single-repo Fine-grained Token and tap **一键同步 Fork 并触发云端更新** — Cloudflare rebuilds in ~30s.
- **🤖 Standalone Repo / AI Users**: Send this prompt to your AI assistant:
  ```text
  Read AGENTS.md from https://github.com/mango0114/rose-panel-bot and upgrade my existing RosePanel Bot deployment by merging upstream into my GitHub repo and pushing so Cloudflare rebuilds automatically. Do NOT create a new Worker, KV, or Bot; if deploying via wrangler, verify the Worker name and KV ID match my existing ones and pass --keep-vars.
  ```
- **💻 Local CLI Users**: Run `git pull && npm ci && npm run build && npx wrangler deploy --keep-vars`.

---

## ⚙️ Environment Variables

| Variable | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `TOPIC_MAP` | KV Binding | ✅ | Persists panel config, sites, visitor archive, and check-in data |
| `BOT_TOKEN` | Secret | ✅ | Telegram Bot Token from `@BotFather` |
| `ADMIN_IDS` | Text | ✅ | Admin numeric Telegram UID(s), comma-separated (`<0.1ms` in-memory auth) |
| `WEBHOOK_SECRET` | Secret | ✅ | Random secret protecting `/`, `/webhook`, and `/setup` |
| `BOT_USERNAME` | Text | Recommended | Bot username without `@` |
| `APP_SHORT_NAME` | Text | Recommended | Mini App short name from BotFather `/newapp` (e.g. `panel`) |
| `SUPERGROUP_ID` | Text | Optional | Forum Topics group ID (**optional**: without a bound group, `ADMIN_IDS` automatically enables Bot DM push; send `/bind` inside a Topics group anytime to switch. Note: DM push uses 1–3 extra KV writes per visitor message, well within Cloudflare's 1,000/day free tier for personal use) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | Text / Secret | Optional | Required only for Cloudflare Turnstile strict verification |
| `PROBE_PROVIDER` | Text | Optional | `komari` (default) / `nezha` / `nodeget` / `json` |
| `PROBE_URL` / `PROBE_API_KEY` | Text / Secret | Optional | Probe URL & credential (`KOMARI_URL` / `KOMARI_API_KEY` still supported; also configurable in Mini App) |

---

## 🤖 Commands

- **General**: `/start` · `/panel` · `/me` · `/checkin` (group mode) · `/rank` (group mode)
- **Admin PM**: `/set` (animated sticker emblem) · `/add` (add sticker quiz) · `/resetbadge` · `/cancel`; in DM push mode, quote-replying a pushed message also supports `/del` `/info` `/ban` `/unban` `/trust` `/reset` `/close` `/open`
- **Inside Forum Topics (Optional)**: `/bind` (auto-switch to Topics) · `/unbind` (fall back to DM push) · `/del` (reply to recall) · `/info` · `/ban` · `/unban` · `/trust` · `/reset` · `/close` · `/open`

---

## 🙏 Credits & Tech Stack

- Protocol & Ecosystem: [Komari Monitor](https://github.com/komari-monitor/komari) · [Combot Anti-Spam (CAS)](https://cas.chat/) · [jikssha/telegram_private_chatbot](https://github.com/jikssha/telegram_private_chatbot)
- Open-Source Stack: [Cloudflare Workers](https://workers.cloudflare.com/) · [Telegram Mini Apps](https://core.telegram.org/bots/webapps) · [React](https://react.dev/) · [Vite](https://vitejs.dev/) · [Lucide Icons](https://lucide.dev/) · [lottie-web](https://github.com/airbnb/lottie-web)

---

## 💬 Feedback

Found a bug, have a deployment question, or want to suggest an improvement? Feel free to open an issue via **[GitHub Issues](https://github.com/mango0114/rose-panel-bot/issues/new/choose)** (choose between Bug Report, Feature Request, or Usage Feedback — please never paste secrets like `BOT_TOKEN` or `WEBHOOK_SECRET`).

---

## 🧧 Support & Sponsors

RosePanel Bot is 100% free & MIT open-source with zero paywalls and zero data collection. If it saves you from Telegram spam or makes your personal profile shine, feel free to support ongoing development ☕✨

- **Live Demo & Contact**: 👉 **[@Rose202_bot](https://t.me/Rose202_bot)**
- **Sponsor via Alipay Password Red Packet (Privacy-Friendly)**: Create an Alipay password red packet of any amount and send the code + your desired display name & note (or anonymous) to **[@Rose202_bot](https://t.me/Rose202_bot)** after passing verification.

### 🏆 Sponsors Wall

<details open>
<summary><b>View Sponsors Wall (Thank you to every supporter 🌸)</b></summary>

| # | Sponsor | Amount | Note |
| :---: | :---: | :---: | :--- |
| 1 | Anonymous | ¥6.66 | 机器人很好用，感谢 (The bot works great, thanks!) |

</details>

---

## 🌟 Star History

<a href="https://www.star-history.com/#mango0114/rose-panel-bot&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=mango0114/rose-panel-bot&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=mango0114/rose-panel-bot&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=mango0114/rose-panel-bot&type=Date" width="100%" />
 </picture>
</a>

---

<div align="center">
  <br />
  <b>⭐ If you find RosePanel Bot useful, please consider giving it a Star!</b><br /><br />
  <sub>MIT License © 2026 <a href="https://github.com/mango0114">mango0114</a></sub>
</div>
