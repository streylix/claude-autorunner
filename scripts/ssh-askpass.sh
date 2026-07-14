#!/bin/sh
# ssh-askpass helper for the Remote Mode CLIENT (src/main/remote-client.js).
#
# When key auth fails and the user types the remote machine's SSH password in
# the connect bar, remote-client re-runs `ssh` with:
#     SSH_ASKPASS=<this script>  SSH_ASKPASS_REQUIRE=force  (+ setsid/no tty)
# and the password in the CCBOT_SSH_PASSWORD environment variable of that ssh
# child only. ssh invokes this script to obtain the password.
#
# Why this shape: the password must never appear in an argv (world-readable
# via ps — the sshpass -p problem), never be written to disk, and never be
# logged. This file therefore contains NO secret; it only echoes the env var
# ssh already carries. Works for every prompt in the connection (password and
# keyboard-interactive), including the long-lived `ssh -N -L` tunnel process.
printf '%s\n' "$CCBOT_SSH_PASSWORD"
