#!/usr/bin/env bash
# T636 live round trip (run as Ethan:  ! bash discord-bridge/tools/t636-roundtrip.sh  ): restart bridge -> start Codex stand-in -> route a test
# message to it -> restart bridge (state survives) -> hand back -> message to 999.
# End state: routing on 999, no Codex terminal left open. Prints evidence per criterion.
# Test lines are sent with source 'synthetic': framed as a bridge self-test and logged with
# meta.synthetic:true, so nothing reads them as Ethan's words.
set -uo pipefail
B=/mnt/smalls/claude-autorunner/discord-bridge
cd "$B"
RUN=${XDG_RUNTIME_DIR:-/run/user/1000}/ccbot-bridge
TOK=$(python3 -c "import json;print(json.load(open('$RUN/vault.json'))['token'])")
PORT=$(python3 -c "import json;print(json.load(open('$RUN/vault.json'))['port'])")
api() { curl -s -H "X-CCBOT-Token: $TOK" -H 'Content-Type: application/json' "$@"; }
j() { journalctl --user -u ccbot-discord-bridge --since "$1" --no-pager | grep -vE "typing indicator" | sed 's/^.*node\[[0-9]*\]: //'; }

echo "=== c0 bridge restart (load /manager) ==="
systemctl --user show ccbot-discord-bridge -p MainPID -p ExecMainStartTimestamp | sed 's/^/old /'
journalctl --user -u ccbot-discord-bridge --since -8h --no-pager | grep -iE "joined voice|left voice" | tail -1 | sed 's/^/last voice event: /'
T0=$(date +%T); systemctl --user restart ccbot-discord-bridge; sleep 18
systemctl --user show ccbot-discord-bridge -p MainPID -p ExecMainStartTimestamp -p ActiveState | sed 's/^/new /'
j "$T0" | grep -E "slash commands|auto-resumed|stand-in|IDLE"

echo; echo "=== c1 start the Codex stand-in ==="
timeout 150 node tools/manager-standin.js codex
ID=$(node tools/manager-standin.js status | python3 -c "import json,sys;print(json.load(sys.stdin).get('terminalId',''))")
echo "stand-in terminal id: $ID"; cat "$RUN/standin.json"; echo
echo "--- trust prompt check ---"
echo "trustPrompt (store): $(python3 -c "import json;print(json.load(open('$RUN/standin.json')).get('trustPrompt'))")"
j "$T0" | grep -i "trust prompt" | tail -2 | sed 's/^/journal: /'
api -X POST "http://127.0.0.1:$PORT/terminal/screen" -d "{\"terminalId\":\"$ID\",\"scrollback\":true}" | python3 -c "import json,sys;s=json.load(sys.stdin)['screen'];print('screen still shows Trust this folder?:', 'Trust this folder?' in s)"
echo "--- waiting 90s for Codex to read its files, GET /state and bin/tell (c5) ---"; sleep 90
echo "--- Codex screen (tail 40) ---"
api -X POST "http://127.0.0.1:$PORT/terminal/screen" -d "{\"terminalId\":\"$ID\",\"scrollback\":true}" | python3 -c "import json,sys;print('\n'.join(json.load(sys.stdin)['screen'].rstrip().split('\n')[-40:]))"
echo "--- c5 evidence in the bridge journal (post-text = bin/tell) ---"
j "$T0" | grep -iE "posted|post-text|manager text" | tail -3

echo; echo "=== c2 route a test message via the bridge's forward path ==="
Q_BEFORE=$(api "http://127.0.0.1:$PORT/queue" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin).get('queue',[]) if int(m['terminalId'])==999]))")
node -e "
const LinkManager=require('./src/linkManager');const StandIn=require('./src/standIn');const {resolveLatest}=require('./src/linkVault');
(async()=>{const lm=new LinkManager();lm.target=resolveLatest();lm.standIn=new StandIn();
console.log('deliveryTerminalId =',lm.status().deliveryTerminalId);
console.log(JSON.stringify(await lm.forward('T636 routing test: reply with the single word codex via bin/tell',{source:'synthetic'})));})();"
sleep 25
echo "--- Codex screen tail (should show the T636 routing test line) ---"
api -X POST "http://127.0.0.1:$PORT/terminal/screen" -d "{\"terminalId\":\"$ID\",\"scrollback\":true}" | python3 -c "import json,sys;s=json.load(sys.stdin)['screen'];print('T636 routing test' in s and 'FOUND in terminal $ID screen' or 'NOT FOUND in terminal $ID screen');print('\n'.join(s.rstrip().split('\n')[-12:]))"
echo "--- 999 queue entries before/after: $Q_BEFORE / $(api "http://127.0.0.1:$PORT/queue" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin).get('queue',[]) if int(m['terminalId'])==999]))")"
echo "--- 999 screen contains the test line? ---"
api -X POST "http://127.0.0.1:$PORT/terminal/screen" -d '{"terminalId":"999","scrollback":true}' | python3 -c "import json,sys;print('T636 routing test' in json.load(sys.stdin)['screen'])"

echo; echo "=== c4 state survives a bridge restart ==="
T1=$(date +%T); systemctl --user restart ccbot-discord-bridge; sleep 18
systemctl --user show ccbot-discord-bridge -p MainPID | sed 's/^/after 2nd restart /'
j "$T1" | grep -E "stand-in|auto-resumed"
echo "store: $(cat "$RUN/standin.json")"

echo; echo "=== c3 hand back to Claude ==="
node tools/manager-standin.js claude
sleep 2
api "http://127.0.0.1:$PORT/state" | python3 -c "import json,sys;ids=[int(t['id']) for t in json.load(sys.stdin)['terminals']];print('terminal $ID still in /state:', $ID in ids)"
node -e "
const LinkManager=require('./src/linkManager');const StandIn=require('./src/standIn');const {resolveLatest}=require('./src/linkVault');
(async()=>{const lm=new LinkManager();lm.target=resolveLatest();lm.standIn=new StandIn();
console.log('deliveryTerminalId =',lm.status().deliveryTerminalId);
console.log(JSON.stringify(await lm.forward('T636 handback test: routing is back on 999, no action needed',{source:'synthetic'})));})();"
sleep 4
echo "--- 999 screen contains the handback line? ---"
api -X POST "http://127.0.0.1:$PORT/terminal/screen" -d '{"terminalId":"999","scrollback":true}' | python3 -c "import json,sys;print('T636 handback test' in json.load(sys.stdin)['screen'])"
echo "final: $(node tools/manager-standin.js status)"
