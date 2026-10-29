# Research

Background research for the Claude Desk design (October 2026); claims are cited, and anything not confirmed from a source is marked UNVERIFIED.
- [`safety-anthropic.md`](safety-anthropic.md): what Anthropic ships for safety and permissions (Claude Code modes and auto mode, Agent SDK hooks, Managed Agents policies), and why a stranger in the user turn changes the design.
- [`safety-landscape.md`](safety-landscape.md): runtime authorization and guardrail products for AI agents as of October 2026, including Harden AIF and Kastra, compared and read for Claude Desk.
- [`safety-patterns.md`](safety-patterns.md): design patterns, papers and production practice for enforcing an owner's charter when the person in the conversation is the adversary.
- [`policy-best-practices.md`](policy-best-practices.md): policy enforcement and authorization for the safety core, starting with Cedar's current releases, use from TypeScript and formal analysis.
- [`architecture-best-practices.md`](architecture-best-practices.md): backend shape for a public, always-on agent with long owner-approval waits and streamed replies: why runs outlive requests, and a separate service versus a full-stack framework.
- [`stack-options.md`](stack-options.md): three hosting and agent-runtime options for the prototype (own Messages API loop, Agent SDK worker, Managed Agents), with platform facts, costs and a recommendation.
- [`ux-patterns.md`](ux-patterns.md): UX lessons from Meta Muse, mid-conversation identity verification, MCP tool profiling and pinning, and owner consoles of customer-facing agents.
- [`claude-ai-design.md`](claude-ai-design.md): claude.ai design tokens, components, wireframes and microcopy, from a read-only look at the web app's UI conventions.
- [`claude-ai-knowledge-plugins.md`](claude-ai-knowledge-plugins.md): how claude.ai presents knowledge, connectors, skills, plugins, per-tool permissions, approvals and notifications.
