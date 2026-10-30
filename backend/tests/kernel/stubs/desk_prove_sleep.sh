#!/bin/sh
# A desk-prove that never answers. Its child holds the output open too, so only killing the whole
# process group ends the run; both carry "desk_prove_sleep" in their command line for pgrep.
sh -c 'sleep 30; exit 0' desk_prove_sleep_child
