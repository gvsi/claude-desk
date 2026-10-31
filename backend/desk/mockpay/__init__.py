"""The mock payments server: a stand-in payment provider that the kernel runs as its child and is
the only client of (master plan, "Payments (mocked)"). No money moves: there is no provider
account, SDK or card anywhere.

- `server`: the app, served on 127.0.0.1:8702 by `python -m desk.mockpay.server`. MCP at `/mcp`
  with exactly two tools, `list_charges` and `create_refund`; the provider routes the kernel's
  adapters call under `/provider/*`, which no tool list ever shows.
- `store`: the `mockpay.*` tables (role desk_mockpay), every row scoped to a copy.
- `definitions`: the two tools' default definitions and the demo's simulated change.
"""
