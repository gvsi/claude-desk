#!/bin/sh
# A stand-in for cvc5 that never answers, for the timeout test: desk-prove must
# stop at its own deadline and kill this process. It records its PID first and
# then becomes `sleep` itself, so killing that PID leaves nothing behind.
if [ -n "$SLEEPING_SOLVER_PIDS" ]; then
  echo "$$" >> "$SLEEPING_SOLVER_PIDS"
fi
exec sleep 30
