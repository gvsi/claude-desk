.PHONY: kernel test

# Rebuild the kernel's Python module into the backend environment, and the
# proof binary the kernel runs. desk-prove and its tests find cvc5 through
# CVC5 or PATH.
kernel:
	cd backend && uv sync --reinstall-package desk-kernel
	cd kernel && cargo build --release --locked -p desk-prove

test:
	cd kernel && cargo test --locked
	cd backend && uv run pytest
