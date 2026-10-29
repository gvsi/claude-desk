# claude.ai: knowledge, integrations (Customize), tool permissions and notifications

Research date: 2026-10-28.

Background research for the Claude Desk design; claims are cited, and anything not confirmed from a source is marked UNVERIFIED.

This was a read-only look at the claude.ai web app's UI conventions, viewed with an organization admin role in dark theme: nothing was connected, toggled or saved.
Sources: live DOM text and accessibility tree, plus `defaultMessage` strings pulled from the app's own JS chunks for states the account couldn't show (no connector is *connected* here, so the per-tool permission UI came from bundle strings, not a live render).
Tokens and typography are in `claude-ai-design.md`; this file doesn't repeat them.

Screenshots captured during the study (not included in this repository):
- `kp-01-connectors-discover.png`: Customize → Connectors → Discover (hero carousel and a 2-col card grid)
- `kp-02-add-custom-connector.png`: the "Add custom connector" modal (step 1)
- `kp-03-connectors-yours.png`: Connectors → Yours (table view)
- `kp-04-connector-detail-overview.png`: connector detail page (Notion), Overview tab with tool chips and a metadata rail
- `kp-05-connector-tools-tab.png`: connector detail, Tools tab ("Tool permissions" empty/preview state)
- `kp-06-skills-yours.png`: Skills → Yours (empty-state banner and a dense list)
- `kp-07-plugin-detail.png`: plugin detail (Productivity) with a "Connectors & tools" side card and a risk badge
- `kp-08-project-knowledge.png`: project page with a Context/knowledge rail
- `kp-09-settings-notifications.png`: Settings modal → General → Notifications toggles
- `kp-10-settings-memory.png`: Settings → Memory
- `kp-11-composer-plus-menu.png`: composer "+" menu with the Add connector submenu
- `kp-12-skill-detail.png`: skill detail with a stat strip and an enable toggle
- `kp-13-project-file-preview.png`: knowledge file preview modal

---

## 0. Information architecture (where things live)

```
Sidebar:  New · Search · Projects · Artifacts · Scheduled · Customize
                                                      │
Customize (full page, h1 "Customize")                 ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ [Skills][Connectors][Plugins]  |  (Yours|Discover)   🔍Search  ≡  ⇅  [+ Add ▾] │
 └──────────────────────────────────────────────────────────────────────┘
Settings (modal over current page, URL hash #settings/<pane>)
  Preferences: General · Account · Privacy · Usage · Capabilities · Memory ·
               Design systems · Claude Code · Cowork
  Customize:   Skills · Connectors · Plugins      (deep-links back to /customize)
  <Org name>:  Organization ↗                     Platform: API keys ↗
```
- There are three kinds of integration, each a **tab**: Skills, Connectors, Plugins. Every tab has the same **Yours | Discover** segmented toggle, which is reflected in the URL (`/customize/connectors` = Discover, `/customize/connectors/yours`).
- The toolbar is identical across tabs: Search field, Filter icon button, Sort (Skills only: "Sort by Last edited"), primary `+ Add ▾` split menu.
- Settings repeats the Customize entries in its nav. The source of truth is the Customize page.
- Knowledge lives inside **Projects** ("Context" rail). Memory lives in **Settings → Memory** and also has a per-project form ("project memory").

---

## 1. Connectors

### 1a. Discover (catalog), `/customize/connectors`
```
Customize
[Skills][Connectors*][Plugins] | (Yours|Discover*)            🔍 Search   ≡   [+ Add ▾]
┌───────────────────────── hero carousel ─────────────────────────┐
│               CURATED BY ANTHROPIC                               │
│  ‹           Claude for science                               ›  │
│      Search literature, plan experiments, and analyze results.   │
│        [logo][logo][logo][logo][logo][logo][logo]                │
│                        [ Explore ]                               │
└──────────────────────────────── • ─ ─ ──────────────────────────┘
Top connectors (8050)                                         Show all →
┌──────────────────────────────┐ ┌──────────────────────────────┐
│[icon] Google Drive ✓verified [+]│ │[icon] Gmail ✓              [+]│
│ Search, read, and upload files │ │ Draft replies, summarize…    │
│ (✓ Added) · by Google          │ │ (✓ Added) · by Google        │
└──────────────────────────────┘ └──────────────────────────────┘
│[icon] Slack ✓ (Auto-connect)  [+]│ ...
Trending connectors (10) · Auto-connect · New connectors · Department: Sales (134) ·
Notes & memory (183) · Finances · Databases · Files & documents · Categories
```
- Card anatomy: 40px app icon tile; **name** with a verified check; optional pill **"Auto-connect"**; one-line description (clamped to 2 lines with an ellipsis); meta row with an outlined pill **"✓ Added"** · "by {Publisher}"; a square `+` icon button at top-right (aria: "Connect {X} to Claude", or "Connect {X} for your team" for org-level ones).
- Community entries carry a **"Community"** tag, and some carry **"Beta"**.
- Section header: title, then a muted count chip, then right-aligned "Show all →".
- Filter menu: `All categories` → Topic / Department / Industry / Everyday life; **Type**: All · Trending 10 · New 8,050 · Verified 1,036 · Community 7,014 · In-chat UI 634 · Desktop extensions 132 · Auto-connect 15.
- `+ Add ▾` menu (Connectors): **"Add custom connector"**.
- Footer: "Submission to the Directory is governed by the Software Directory Terms; use of Connectors is governed by your relevant terms."

### 1b. Yours (installed list), `/customize/connectors/yours`
```
Connector                     Type     Authorization   Status
[ic] Asana                    Web      —               [Connect]
[ic] Atlassian                Web      —               [Connect]
...                                                     (row click → detail)
┌──────────────────────────────────────────────────────────────────────┐
│ Build for the Claude Directory                [Developer docs ↗] [Submit to the directory] │
│ List your connector or plugin and reach everyone using Claude.                │
└──────────────────────────────────────────────────────────────────────┘
```
- This is a plain table (no cards). Whole rows are clickable (aria "View {X}"). The Status column holds an inline `Connect` button when the connector isn't connected; "Authorization" shows "—" until it is.
- Detail for a disconnected connector (`/yours/id/<uuid>`): breadcrumb "← Your connectors", the empty line **"You're not connected to Notion yet."** and `[Connect]`, plus a kebab with **View details** and **Remove for everyone** (admin).

### 1c. Connector detail (directory page), `/customize/connectors/id/<id>[/configuration|/tools]`
```
                                                                     🔗 Copy link
← Connectors
┌────┐ Notion ✓  (✓ Added)                               [Connect to Claude | ▾]
│ N  │ Connect your Notion workspace to search, update,     (▾ → "Remove from your team")
└────┘ and power workflows across tools
 Overview* | Configuration | Tools                     (tabs = sub-routes)
┌──────────────── main (2/3) ────────────────┐  ┌──── rail (1/3) ────┐
│ Long description paragraph                 │  │ MADE BY  Notion ↗  │
│                                            │  │ CATEGORIES [chip][chip][chip] │
│ Tools                                      │  │ SIGN-IN  Required  │
│ (create-comment) (get-comments) (search)   │  │   Supports auto-connect │
│ (create-database) (get-self) (update-…)    │  │ CONNECTOR URL      │
│ … 3-column grid of outlined mono-ish chips │  │   https://mcp.notion.com/mcp [copy] │
│                                            │  │ ADDED  November 2025 │
│ ┌ⓘ Only use connectors from developers you │  │ MORE INFO          │
│ │  trust. Anthropic does not control which │  │  Documentation ↗   │
│ │  tools developers make available and     │  │  Support ↗         │
│ │  cannot verify that they will work as    │  │  Privacy Policy ↗  │
│ │  intended or that they won't change.     │  └────────────────────┘
│ └──────────────────────────────────────────┘
Related connectors (2-col card grid, same cards as Discover)
```
- **Configuration tab:** "These settings apply when this connector is used in Claude.ai, Claude Desktop, or Claude Code cloud sessions. The Claude Code CLI and Desktop Extensions connect separately." Then **Authentication** with two choices: *Browser sign-in*, "Each member signs in to Notion through their browser to connect.", or *Managed authorization*, "Connect members through your identity provider." `[Set up]`, with the footnote "Managed authorization requires your organization to use a supported identity provider for SSO. Learn more".
- **Tools tab, before connecting:** heading **"Tool permissions"**, then "Connect to load this connector's tools, then choose which ones your team can use.", a **"Preview"** pill, and a wrapping row of filled tool-name chips (`search` `fetch` `create-pages` …).

### 1d. Per-tool permission model (from app strings; not live-rendered here)

**User level** (a connected connector's settings, also reused per project and per chat):
```
Tool permissions
Choose when Claude is allowed to use these tools.
You'll only see tools your organization has given you access to.

Interactive tools                     [ Custom ▾ ]   ← group-level "Blanket permission for group"
  tool_a                              [✓ | ? | ⊘]    ← per-tool segmented icon control
Read-only tools                       [ Always allow ▾ ]
  search                              …
  fetch                               …
Write/delete tools                    [ Needs approval ▾ ]
  create-pages                        …   🔒 "Your admin requires approval for this tool. You can still block it."
Other tools                           …
App-only tools                        …
```
- **The three levels: "Always allow" · "Needs approval" · "Blocked".** The group-level control adds **"Custom"** for mixed states, and an aria label reads "{value}, {group}: permission for all tools".
- Tools are **grouped by risk class**: *Interactive tools*, *Read-only tools*, *Write/delete tools*, *Other tools* (unannotated), *App-only tools*.
- Inherited and locked states are explained inline: "Blocked by your admin", "Permission set by your admin", "Permission set by {connectorName}", "Uses default", and a Lock icon with tooltip "Your admin requires approval for this tool. You can still block it."
- Disambiguation copy: "Why this tool needs approval again"; "Why no choice is selected", then "Some chats can run this tool without asking, because an "Always allow" is saved for it. Other chats ask first. Pick a setting here to use the same one in every chat."
- Safety caveat: "Claude may still ask before using tools that can make changes, even when they're set to "Always allow." Your admin manages this for your organization."
- Mode caveat: "'Always allow' is disabled for Cowork by your organization admin. It is still available in Chat mode."
- Empty state: "No tools are available — they've been restricted by your organization."
- Project and chat connector picker strings: "Customize {serverName}", "Search tools", **"Enable all tools" / "Disable all tools"**, "No tools matching "{search}"", "Allow access to connectors and tools", "This project requires specific connectors to fulfill its full potential:".

**Admin level** ("Tool permission restrictions" act as a ceiling):
- "Restrict which permission levels users in your organization can choose for each tool. Restrictions set a ceiling — users can always choose a stricter setting."
- A per-tool segmented control (aria "Tool permission restriction") with tooltips: **"Users can choose: Always allow, Ask, or Block"** / **"Users can choose: Ask or Block"** / **"Tool blocked for all users"**.
- Also "Use connector default"; "Applies to tools without a specific restriction below, including tools this connector adds later."; "Anthropic requires approval for this tool on every use"; "This connector is managed by Anthropic. Tool restrictions are not available for it."
- Role-wide setting: "Permission for all connectors". "Set permissions for all current and future connectors, or customize per connector. If set to Custom, any connectors added to your organization later will start as Blocked for this role."
- Policy enum strings: `allow` "Always allow" · `ask` "Ask each time" · `ask-session` "Ask once per session" · `blocked` "Blocked".

**Run-time approval card (in chat/task)**
- Title: "Claude wants to use {toolName} from {integrationName}" (variants: "Claude wants to use {toolName}", "Claude wants to {action}", "Claude wants to use your browser" / "…your computer").
- Buttons: primary **"Allow once"** (⌘↵), secondary **"Always allow"** / "Allow for this task" / "Allow for all tasks" / "Allow for this session" / "Always allow for this website" / "Allow for all scheduled runs" (⌘⇧↵, behind **"More allow options"**), and **"Deny"** (esc).
- Locked variants: ""Always allow" isn't available for this command."; "Your admin requires approval each time for this tool. Ask them to change its permission in Organization settings → Connectors or Roles."
- Status chips in task lists use **"Needs approval"** in warning colour, and the waiting row reads "Needs approval — {title}". The banner reads "Claude needs your input to continue".

### 1e. Add custom connector (modal)
```
┌ Add custom connector                         Step 1 of 2     ✕ ┐
│ Connect Claude to your data and tools. Learn more about        │
│ connectors or get started with pre-built ones.                 │
│ [ Name                                                       ] │
│ Shown in the connectors list.                                  │
│ [ MCP server URL                                             ] │
│ The HTTPS address where the server accepts MCP requests, for   │
│ example https://mcp.example.com/mcp.                           │
│                                                                │
│ Only use connectors from developers you trust. Anthropic does  │
│ not control which tools developers make available and cannot   │
│ verify that they will work as intended or that they won't      │
│ change.                                                        │
│ Building an MCP server? Report issues and subscribe to updates │
│ here                                                           │
│                                          [Cancel] [Continue]   │  (Continue disabled until valid)
└────────────────────────────────────────────────────────────────┘
```
- Step 2 includes **"Advanced settings"**, with "OAuth client ID (optional)" and "OAuth client secret (optional)", plus a "Connects to {host}" confirmation line.
- Warnings:
  - "This connector was suggested by an external link. Verify the name and URL are from a developer you trust before adding."
  - "This connector will use SSE transport, which is being deprecated. … You can change transport under Advanced on the next step."
  - "If the new URL uses a different authorization server, members may need to reconnect…"
- The composer `+` menu also exposes it: "Add connector ›" leads to **Browse connectors** / **Add custom connector**. Unconnected first-party sources show inline in the menu: "Add from Google Drive · Not connected" and "Log in to Google Drive [Connect]".

### 1f. Capabilities settings that affect tools
- **Tool access mode**: "Controls how connector tools are loaded in new conversations." Options: **"Load tools when needed"** / **"Tools already loaded"** (dropdown with a description under each).
- **Connector search**: "Let Claude search the connector directory and surface ones relevant to your conversation."

---

## 2. Skills and Plugins

### Skills → Yours (`/customize/skills/yours`)
```
┌───────────────────────────────────────────────────────────┐
│ Add your first skills                               ✈ illo │
│ Skills teach Claude how you work. Add them from Discover,  │
│ or create your own.                                        │
│ [Discover skills]                                          │
└───────────────────────────────────────────────────────────┘
From Anthropic & Partners (5)
[ic] skill-creator                                          8h ago   ⋯
     from Anthropic · Create new skills, modify and improve…
[ic] google-workspace                                       Oct 14   ⋯
```
- A dense one-line list: icon tile, name, then "from {source} · {description truncated}", relative date, and a kebab (menu: **Remove**).
- `+ Add ▾` (Skills): **Upload skill** · **Create a skill** · **Create with Claude**.
- Skill detail: "← Your skills"; header shows name, "by Anthropic · updated Sep 14", **[💬 Try in chat]**, ⋯, and an **enable toggle**. Tabs: Overview | Contents · 3. A **stat strip**: Adoption "— users in your organization · 30 days" | Activity "— runs · 30 days" | You "— runs by you · 90 days". Then Description, and a side card "Created by".

### Skills/Plugins → Discover
- "From Anthropic" hero card ("Data — Query, chart and explain your data…" [Add]); rows "New skills", "Most installed skills" with "by Anthropic · 8.4M installs" (tooltip "8,415,611 installs across all of Claude"); per-card **[Try]** and the provenance tag "Anthropic Directory".

### Plugins → Yours (empty state)
"Add your first plugins" / "Give Claude role-level expertise with plugins. Add them from Discover, or create your own." [Discover plugins], plus the "Build for the Claude Directory" banner.

### Plugin detail (`/customize/plugins/id/<id>[/contents]`)
```
← Plugins
[ic] Productivity                                                      [Add]
     by Anthropic · 1.3.1 · 4 skills · updated Sep 22
 Overview* | Contents · 10 | Skills · 4 | Connectors · 9
┌ Adoption — users in your org · 30 days │ Activity — runs · 30 days ┐  ┌ Connectors & tools ─────┐
Description …                                                          │ 🌐 Can send data to   ⓘ │
Categories (Operations)(Tickets & tasks)(Claude history)(Email & …)    │    other services       │
Try it  ▷"Set up my task and memory system"  ▷"What's on my plate…"    │ [ic] Slack · slack      │
                                                                       │ [ic] Notion · notion …  │
                                                                       └─────────────────────────┘
```
- **Capability/risk badge** (first row of the side card), one of three:
  - "Only adds instructions for Claude" (Code icon)
  - "Can run code without asking" (Lightning icon)
  - "Can send data to other services" (globe icon)
- The Contents tab is a file tree (`.claude-plugin/plugin.json`, `skills/…`, `.mcp.json`, `README.md`) with a rendered README, and the header line "Productivity 1.3.1 · synced Sep 22 · current".

---

## 3. Knowledge (Projects) and Memory

### Project page (`/project/<id>`)
```
Projects / How to use Claude
How to use Claude                                          📌  [🏢 Share]  ⋯
Created by Anthropic · 🏢 Shared with your organization
An example project that also doubles as a how-to guide…
┌──────── composer ────────┐                        ┌──── right rail ────────────┐
│ How can I help you today?│                        │ ✋ Add relevant context for  │
│ + (Chat|Cowork)  Opus 5.5│                        │    your project             │
└──────────────────────────┘                        │ Upload documents, code, and │
(Chats and tasks*)(Activity)   🔒 All chats are     │ other files to the project  │
                                 private unless shared│ for Claude to reference…    │
        💬                                          ├─────────────────────────────┤
 Claude references the same knowledge every time    │ Context                  🔍 │
 you talk to it in this project.                    │ ┌───────────┐               │
                                                    │ │Claude      │  file tile:   │
                                                    │ │prompting   │  name, size,  │
                                                    │ │guide.md    │  type badge   │
                                                    │ │18.2kB  [MD]│               │
                                                    │ └───────────┘               │
                                                    ├─────────────────────────────┤
                                                    │ Scheduled                 + │
                                                    │ Set up recurring tasks for  │
                                                    │ this project.               │
                                                    └─────────────────────────────┘
```
- The knowledge region is labelled **"Project knowledge"** (aria) and titled **"Context"**. Files render as **portrait tiles** (name, size, uppercase type badge). Clicking a tile opens a **preview modal** with the rendered markdown.
- The Activity tab empty state reads: "Add to project knowledge or share your chats to spark ideas, learn from teammates, and discover how your team uses Claude."
- Owner-only strings (from the bundle):
  - **Add menu:** "Upload from device", "Add text content" (fields "Title / Name your content", "Content / Type or paste in content..."), "Add files", plus MCP resources: "Search resources or paste URL".
  - **Drop zone:** "Drop files here to add to project knowledge".
  - **Capacity meter:** "{pct}% of project capacity used", and at the limit "Project knowledge at capacity. Remove an existing file in order to add to knowledge".
  - **File states:** "Uploading...", "Synced source", "Syncing...", "Sync failed" with "Retry sync" / "Sync now"; row action "Remove from project"; "Choose how to read this file".
  - **Empty:** "Add PDFs, documents, or other text to reference in this project." and "No matching files."
  - **Instructions block:** "Add instructions to tailor Claude's responses" / "Edit instructions" / "View instructions".
  - **Project memory:** "Memory · Last updated {time} · View memory / Edit memory"; "No memory yet"; "View account memory"; "Claude regenerates project memory every evening from your past chats in this project. Only you can see this memory, and it is not shared with other project users."

### Settings → Memory
- **Search and reference chats**: "Allow Claude to search for relevant details in past chats. Learn more". Toggle.
- **Generate memory from chats**: "Allow Claude to generate memory from your chats. Learn more". Toggle.
- When on (bundle strings): **"Manage memory"** modal, "Here's what Claude remembers about you! This summary is regenerated each night and does not include projects, which have their own specific memory." (tabs Summary / Edit, "Manage edits"). The two destructive confirmations:
  - **Pause memory**: "Claude keeps its existing memory but won't use memory or make new memories."
  - **Reset memory** (danger): "This will permanently delete all memories, including project memories. This can't be undone."

---

## 4. Notifications and approvals (Settings → General → Notifications)
Each row is a label, a one-line description, and a right-aligned switch, separated by hairline dividers:

| Label | Description | (state seen) |
|---|---|---|
| Response completions | Get notified when Claude has finished a response. Useful for long-running tasks. | off |
| Scheduled tasks | Get notified when scheduled tasks finish, can't run, or need your input. | on |
| Code notifications | Claude can choose to notify you about important updates from a Code session. | off |
| **Code permission requests** | Get a push notification when Claude needs your approval to run a command in a Code session. | off |
| Emails from Claude Code cloud sessions | Get an email when a cloud session has finished building or needs your response. | off |
| Spend-limit alerts for {Org} | Emails when members reach their spend limit or request more usage. | on |
| Mentions and replies | Get an email when someone @mentions you on an artifact, or replies in a comment thread you're part of. | on |
| Comments on your artifacts | Get an email when someone comments on an artifact you own, even when you're not mentioned. Follows "Mentions and replies" until you change it. | on |
| Artifacts shared with you | Get an email when someone shares an artifact with you. | on |

- The list is flat: no channel matrix. The **channel goes in the copy** ("push notification", "email"), and each row covers one event family. One row inherits from another ("Follows "Mentions and replies" until you change it").
- In-product notification affordances: sidebar badge **"19 new"** on a scheduled task, per-row **"Mark as unread"**, status dots (Idle/Done), and "Needs approval" chips in warning colour.

---

## 5. Patterns Claude Desk should mirror

1. **Three-way permission vocabulary, used everywhere:** **Always allow · Needs approval · Blocked** (with "Custom" only as a derived group state). Use the same words in settings, run-time approval cards and admin ceilings. Admin restrictions read as "Users can choose: Ask or Block".
2. **Group tools by risk class before name:** Read-only, Write/delete, Interactive, Other. Put a group-level "blanket" control in each header and per-tool segmented icons in the rows. Default write/delete to Needs approval.
3. **Explain every locked or inherited state in place:** a Lock icon plus a sentence ("Permission set by your admin", "Your admin requires approval for this tool. You can still block it."). Ceilings are framed as "users can always choose a stricter setting".
4. **Detail page = header, tabs that are routes, and a metadata rail:** Overview / Configuration / Tools. The rail uses small-caps labels (MADE BY, SIGN-IN, CONNECTOR URL with copy, ADDED, MORE INFO links). Tool lists on Overview are outlined name chips; a "Preview" pill marks them as not yet live.
5. **Yours vs Discover as one segmented toggle with the same toolbar** (Search · Filter · `+ Add ▾`). Discover uses rich cards in a 2-col grid with "Show all →" sections and count chips. Yours is a dense table or list (Name · Type · Authorization · Status with an inline action).
6. **Trust copy at the moment of adding:** a boxed ⓘ caveat ("Only use connectors from developers you trust…"), verified checkmarks, "by {Publisher}", and Community/Beta tags. Add-custom is a small 2-step modal (Name + server URL with helper text under each field; optional OAuth fields under "Advanced settings").
7. **A capability/risk badge on bundles:** "Only adds instructions" / "Can run code without asking" / "Can send data to other services". This makes a good headline for Claude Desk's tool-profile review screen.
8. **Run-time approval card:** "Claude wants to use {tool} from {integration}". Primary "Allow once", a split for broader scopes (this task / all tasks / always), and "Deny", each with keyboard hints (⌘↵, ⌘⇧↵, esc). The queued state shows a warning "Needs approval — {title}".
9. **Knowledge as a side rail of tiles:** an intro card explaining why to add context, then "Context" + search + file tiles (name, size, TYPE badge) that open a preview, a capacity line "{pct}% of project capacity used", and sync states (Syncing / Sync failed / Retry sync). Memory is separate and summarized ("regenerated each night"), with Pause and Reset as explicit, explained actions.
10. **Notifications as a flat, plain-language toggle list:** one row per event family, the channel named in the description, inheritance stated in words, and an approval-specific row ("…when Claude needs your approval…"). Empty states always pair one sentence with a single primary CTA ("Add your first skills" / [Discover skills]).
