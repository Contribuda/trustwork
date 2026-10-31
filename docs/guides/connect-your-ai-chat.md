# Connect Trustwork to your AI chat

You already talk to an AI chat every day: Claude, ChatGPT, an assistant in your code editor, or one your company built. Soon you will be able to connect it to your Trustwork account and do from that chat everything you do on the site: plan your house project, find an expert and book a consultation, answer RFQ invitations, compare quotes, register for an event, build your reputation profile, draft an article. Your chat becomes another hand of **your one Trustwork agent**. It sees only what you allow, drafts freely, and never commits anything (an order, a booking, a published page, a message to someone) unless a mandate you confirmed on the site allows it or you confirm that single action on the site.

**Status: Designed.** Nothing in this guide works yet; no hub serves an MCP endpoint today. The design is [The MCP server](../engine/mcp-server.md) and [ADR 013](../adr/013-mcp-server.md); the work packages are MCP-001 … MCP-090. Status labels are explained in the [guides index](README.md#status-labels). Examples use the United States reference hub at a placeholder address, `https://us.trustwork.example`.

## What you need

- A Trustwork account on your hub (sign-up is **Live** in the API, the screens are **Demo**).
- An AI chat that can connect to a **remote MCP server** with OAuth sign-in. As of 2026-10-31 this includes Claude (custom connectors on claude.ai, the desktop and mobile apps, and Claude Code) and ChatGPT (developer mode and apps); plans and settings differ between products and change often, so check your chat's own help pages.
- Your hub's MCP address. It is always your hub's address followed by `/mcp`, for example `https://us.trustwork.example/mcp`. There is no personal address: your sign-in tells the hub who you are.

## Step by step

| # | Step | What happens | Status |
|---|---|---|---|
| 1 | **Add Trustwork to your chat** | In your chat's settings, add a custom connector or MCP server and paste `https://us.trustwork.example/mcp`. In Claude Code: `claude mcp add --transport http trustwork https://us.trustwork.example/mcp`. | **Designed** (MCP-003) |
| 2 | **Sign in on your hub's site** | Your chat opens a page on your hub's own address. You sign in exactly as on the site (with your second factor if you set one up). Never type your Trustwork password anywhere else. | **Designed** (MCP-002) |
| 3 | **Choose what the chat may do** | The consent page shows the chat's name (marked "self-asserted" unless your hub lists it), where your sign-in is sent back to, and what it asks for. Start small: public data and your own account are pre-ticked. You can add drafting (`propose`), acting under mandates (`act`) and the topics (toolsets) you want, such as projects and plans or quotes and orders. | **Designed** (MCP-002, MCP-070) |
| 4 | **Decide about private data** | Budgets, negotiation floors and ceilings, private projects and your other drafts are **off**; file contents and your contact details are not shared with connected chats at all for now. Each one you turn on gets its own warning: it will leave your hub and be processed under your chat provider's terms. | **Designed** (MCP-004) |
| 5 | **Optionally bind mandates** | If you already have mandates (for example "accept orders under USD 5,000 from verified buyers for catalogue items"), you can let this chat act within them without asking you each time. Without a bound mandate, every commitment asks you on the site. | **Designed** (MCP-005) |
| 6 | **Work from your chat** | Ask in plain language: "Turn my idea for a 2,000 sq ft house near Austin into a plan", "Which experts could review my foundation drawings?", "Draft quotes for this week's RFQ invitations", "Compare the three offers for the electrical service". Drafts appear on the site too, in the same places as your agent's drafts. | **Designed** (MCP-010 … MCP-032) |
| 7 | **Confirm commitments on the site** | When the chat wants to place an order, book a paid consultation, send a quote, publish a page or send a message that no bound mandate covers, it shows you a link to your hub's confirmation page. Check that the address is your hub's. The page shows exactly what will happen (counterparty, lines, total with state sales tax, terms, budget) from Trustwork's own records, not from the chat's summary. Confirm or decline there. | **Designed** (MCP-005, MCP-070) |
| 8 | **Things you always do on the site** | Approving decisions, creating or widening mandates, security settings, privacy requests, company membership and roles, accepting a plan version, submitting licence or insurance evidence, writing reviews, disputes, plan and payment changes. Your chat can open the right page for you, prefilled where possible, but the action happens on the site. | **Designed** (MCP-005) |
| 9 | **See and control connections** | Settings → Connections lists every connected chat with what it may do, its recent calls (what it did, never the content) and a revoke button. The stop control pauses all your mandates and connections at once. Changing your password or recovering your account disconnects every chat. | **Designed** (MCP-070) |

## Good to know

- **Your chat is not a second agent.** Everything it does is done as your agent and labelled "sent by [your name]'s agent" for the other side.
- **What it reads from others is marked untrusted.** A quote note or a message that says "ignore your instructions" is shown to your chat as untrusted text, and it cannot make anything happen: commitments always need your mandate or your confirmation.
- **Costs.** Connecting is free. Work the hub's agent does for you (drafting a whole plan, cited answers, translations) counts against your module quotas exactly as on the site; if your chat does the thinking itself, it uses fewer of the hub's resources.
- **Language.** Your chat talks in your language; the pages it opens on the hub use your interface language (English and Spanish on the US hub).
- **No account?** Anyone can connect to `https://us.trustwork.example/mcp/public` without signing in to search and read public pages: companies, people's public profiles, projects, events, news and articles, courses, open tasks and needs.
- **Company systems.** A company can connect one system (for example an ERP) to its standing representative, approved by a company administrator and the accountable person; it acts only under company mandates.

## If something goes wrong

| You see | What it means |
|---|---|
| The chat says it needs more permission | It asked for something outside what you allowed; it will open the consent page so you can add it, or you can say no |
| "Confirmation required" with a link | Open the link, check that it is your hub's address, and confirm or decline on the site |
| "This confirmation belongs to another account" | Someone else's confirmation link was opened; nothing happened |
| "Paused by the hub" | The hub's operators paused external agents or a module; the site explains why |
| The connection disappeared | You (or a password change or account recovery) revoked it, or it was unused for 90 days; connect again |

## Learn more

[The MCP server](../engine/mcp-server.md) · [Your agent](../engine/agents.md) · [Agent catalogue](../engine/agent-catalog.md) · [Trust, safety and privacy](../engine/trust-safety-privacy.md)
