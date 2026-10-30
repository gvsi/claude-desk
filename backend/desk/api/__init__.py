"""The API process (port 8700): Claude's loop, the visitor and owner APIs and the job worker.

It holds only the Anthropic API key and its database role, reaches the kernel only through
`kernel_client.KernelHttp`, and never imports the kernel service, its Rust module or the mock
payments server (tests/api/test_boundaries.py).
"""
