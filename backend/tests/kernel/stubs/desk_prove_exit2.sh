#!/bin/sh
# A desk-prove that ends in a tool error, as the real one does when cvc5 is missing or the run is out
# of time: exit 2. Its report is printed but the kernel never needs it.
echo '{"ok": false, "method": "symcc", "cases": null, "timed_out": true, "checks": []}'
exit 2
