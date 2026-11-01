# Hermes Deck v3 — Make It Graded-Functional + Issue Hunt

## Goal

Make the Hermes Deck (KOReader home-screen takeover plugin on the Kindle Scribe) demonstrably functional — every tile, the hero card, and the takeover itself verified working — and find/fix its bugs through a repeatable test loop instead of guess-and-redeploy.

## Current context / assumptions

- **Artifact under test**: `~/scribe-fix/hermes-deck-v3.lua` (406 lines), deployed to the Scribe at
  `M="/run/user/1000/gvfs/mtp:host=Amazon_Kindle_Scribe_G093X5064472020N_G093X5064472020N/Internal Storage"`
  → `$M/koreader/plugins/hermes-deck.koplugin/main.lua` (14,027 bytes, deployed 16:33).
- **Device**: Kindle Scribe `G093X5064472020N`, KOReader **v2026.07.1** (from `$M/koreader/git-rev`), KPM-booklet launch (`documents/KOReader.sh` → `kpm launch koreader`).
- **Takeover config**: `["start_with"] = "hermes_deck"` written at line 238 of `$M/koreader/settings.reader.lua` (validated parseable). **Unverified on glass** — the v3 boot test hasn't happened yet.
- **No git repo** in `~/scribe-fix` — v1/v2/v3 are loose files. No automated tests exist.
- **Known-good facts from this session**: `gio copy` is the only working MTP write path; `lua5.1 -e "assert(loadfile(...))"` is the local syntax gate; the old notebook `framecontainer` crash is fixed; SSH into the Scribe works only when the SSH plugin is running on-device (dropbear :2222, tailnet IP 100.73.123.24).
- **Suspect areas in v3** (found by reading the source, to be confirmed by tests):
  1. `make_tile` (line ~145): tap handling sets `wdg.handleEvent` on an `OverlapGroup` — KOReader widgets receive taps via `handleTap`/`onTap` through the UIManager's tap routing, which requires the widget to be *registered* (shown as a top-level with `handle_back`/tap zones) — custom `handleEvent` on a child group may never fire. **Tiles may be untappable.**
  2. `DECK:showDeck()` shows a raw `FrameContainer` as a top-level widget — it has no `ModalWidget`/`FocusManager`, so taps may pass through to the file browser underneath.
  3. `heroCard` reads `dd.data.last_percent_complete` — DocSettings may not have `data` loaded without `dd:readSetting()`; progress bar may silently never render.
  4. `news_action` calls `FileManager.instance.file_chooser:changeToPath` — method name must be verified against v2026.07.1 (`changeToPath` exists in `ui/filechooser.lua`; confirm).
  5. `start_with` takeover: KOReader's FM checks `G_reader_settings:readSetting("start_with")` in `apps/filemanager/filemanager.lua` — if the value isn't one of its known keys it may fall through to default *without* calling plugin code; our `init()` nextTick-show is the only hook. **This is why v2's auto-open failed; v3's mechanism must be verified first.**
  6. `DateTime` required but unused; `open_book` removed — harmless, but lint noise.

## Architecture / proposed approach

Two-tier testing: **(Tier 1) offline static gates** on Onyx-Linux — Lua syntax, a stub-harness smoke test that `require()`s the plugin with fake KOReader modules and exercises every action function, and a `busted`-style spec — plus **(Tier 2) on-device verification loop** — deploy via `gio copy`, reboot KOReader, pull `crash.log` + a screenshot via SSH (SSH plugin kept on), and walk a written test checklist. Every fix follows TDD: encode the failure as a stub-harness test first, then patch, then redeploy.

## Step-by-step tasks

### Phase 0 — Baseline & safety (git + backup)

**T0.1** Init git in `~/scribe-fix` and commit the current state.
```bash
cd ~/scribe-fix && git init -q && git add -A && git commit -qm "baseline: deck v3 as deployed 2026-10-23"
git log --oneline   # expect: 1 commit
```

**T0.2** Verify the on-device backup is current before touching anything:
```bash
ls ~/scribe-backup-20261023/ | head
diff <(gio cat "file://$M/koreader/plugins/hermes-deck.koplugin/main.lua") ~/scribe-fix/hermes-deck-v3.lua && echo IDENTICAL
```
Expected: `IDENTICAL`. If not, re-copy v3 first.

### Phase 1 — Tier 1 offline test harness (the "grade")

**T1.1** Create `~/scribe-fix/test/stubs/` with fake KOReader modules so the plugin can be `require`d under plain `lua5.1`. Each stub is a table with `extend`/`new` returning self-shaped tables. Minimum set (one file each, mirroring the require paths from lines 17–34 of `hermes-deck-v3.lua`):
```
ui/uimanager.lua            -- show/close/nextTick/setDirty record calls into a global LOG
ui/widget/container/widgetcontainer.lua
ui/widget/container/framecontainer.lua
ui/widget/container/centercontainer.lua
ui/widget/container/leftcontainer.lua
ui/widget/container/rightcontainer.lua
ui/widget/container/widgetcontainer.lua
ui/widget/verticalgroup.lua ui/widget/horizontalgroup.lua ui/widget/overlapgroup.lua
ui/widget/textwidget.lua ui/widget/linewidget.lua ui/widget/progresswidget.lua
ui/widget/blankwidget.lua ui/widget/infomessage.lua ui/widget/confirmbox.lua
ui/font.lua                 -- getFace returns {}
device.lua                  -- { screen = { getWidth=..., getHeight=..., scaleBySize=... }, batteryInfo=... }
gettext.lua                 -- return function(s) return s end
ffi/util.lua                -- template = string.format-ish
datetime.lua, pluginloader.lua, docsettings.lua, readhistory.lua,
apps/filemanager/filemanager.lua, apps/reader/readerui.lua
```
Complete copy-paste starter for the two trickiest stubs:

`test/stubs/ui/uimanager.lua`:
```lua
local M = { log = {} }
function M:show(w) table.insert(self.log, {"show", w}); return true end
function M:close(w) table.insert(self.log, {"close", w}); return true end
function M:nextTick(f) f(); return true end
function M:setDirty() end
return M
```

`test/stubs/device.lua`:
```lua
return {
  screen = { getWidth = function() return 1404 end,
             getHeight = function() return 1872 end,
             scaleBySize = function(n) return n end },
  batteryInfo = function() return { percentage = 87 } end,
}
```

**T1.2** Write the failing smoke test `~/scribe-fix/test/smoke.lua`:
```lua
package.path = "test/stubs/?.lua;" .. package.path
_G.G_reader_settings = { readSetting = function(_, k)
    if k == "start_with" then return "hermes_deck" end end }
local reg = require("hermes-deck-v3")   -- adjust: file returns { hermes_deck = DECK }
local deck = reg.hermes_deck
local d = deck:new()
d:init()                                -- must not error
d:showDeck()                            -- must not error
for _, app in pairs(d._APPS or {}) do end -- see T1.3
print("SMOKE-OK")
```
Run: `cd ~/scribe-fix && lua5.1 test/smoke.lua`
Expected NOW: **fails** (missing stub or nil error) — that's the RED step. Add stubs until it prints `SMOKE-OK`.

**T1.3** Refactor `hermes-deck-v3.lua` minimally so actions are testable: move the `APPS` table to `DECK._APPS = APPS` (one line, after line 194) so the harness can iterate every tile action:
```lua
DECK._APPS = APPS
```
Then extend `smoke.lua` to call every action with pcall and assert none raises:
```lua
for _, app in ipairs(deck._APPS) do
    local ok, err = pcall(app.action)
    assert(ok, app.label .. " action raised: " .. tostring(err))
end
print("ACTIONS-OK")
```
Expected: `ACTIONS-OK`. Any action that raises = a real bug → fix in the plugin, re-run, commit per fix.

**T1.4** Static gate script `~/scribe-fix/check.sh` (the repeatable "grade"):
```bash
#!/bin/sh
set -e
cd "$(dirname "$0")"
lua5.1 -e "assert(loadfile('hermes-deck-v3.lua'))"
luac5.1 -p hermes-deck-v3.lua 2>/dev/null || true
lua5.1 test/smoke.lua
echo "GRADE: PASS"
```
`chmod +x check.sh && ./check.sh` → expect `GRADE: PASS`.

### Phase 2 — Tier 2 on-device verification (the "issue hunt")

**T2.1** Enable reliable device access *before* testing: on the Scribe, KOReader menu → Settings → **SSH server: enable** (dropbear :2222), and confirm tailnet:
```bash
timeout 8 ssh -p 2222 -o ConnectTimeout=5 -o BatchMode=yes root@100.73.123.24 'echo SCRIBE-SSH-OK'
```
Expected: `SCRIBE-SSH-OK`. If the Scribe sleeps mid-test, wake via power button; SSH reconnects.

**T2.2** Deploy loop (save as `~/scribe-fix/deploy.sh`):
```bash
#!/bin/sh
set -e
M="/run/user/1000/gvfs/mtp:host=Amazon_Kindle_Scribe_G093X5064472020N_G093X5064472020N/Internal Storage"
cd "$(dirname "$0")"
./check.sh                                   # never deploy broken code
gio copy -b hermes-deck-v3.lua "$M/koreader/plugins/hermes-deck.koplugin/main.lua"
grep -c 'start_with' "$M/koreader/settings.reader.lua"   # expect: 1
echo DEPLOYED
```

**T2.3** Reboot KOReader cleanly from PC (no button needed):
```bash
ssh -p 2222 root@100.73.123.24 'killall -TERM KOReader 2>/dev/null; sleep 2; lipc-send-message com.lab126.booklet reader "viewbook" "string:/mnt/us/documents/KOReader.sh"'
```
Wait ~25 s, then verify the takeover fired by checking the process tree:
```bash
ssh -p 2222 root@100.73.123.24 'pgrep -f KOReader && echo KR-RUNNING'
```

**T2.4** Pull the crash log and diff against the known-good baseline:
```bash
scp -P 2222 root@100.73.123.24:/mnt/us/koreader/crash.log /tmp/scribe_crash.log
grep -nE 'hermes_deck|error|attempt to|not found' /tmp/scribe_crash.log | tail -20
```
Expected: zero `hermes_deck` lines. Any hit = a graded failure → write a stub test reproducing it (T1.3 pattern), fix, redeploy.

**T2.5** Screenshot verification (proves the deck actually rendered, not just "no crash"):
```bash
ssh -p 2222 root@100.73.123.24 'screencap /mnt/us/deck_shot.png 2>/dev/null || cat /dev/fb0 > /mnt/us/deck_shot.raw'
scp -P 2222 root@100.73.123.24:/mnt/us/deck_shot.png ~/scribe-fix/shots/
```
Then `vision_analyze` the PNG: confirm status strip, hero card, 8 tiles visible. (KOReader's own `screencap` may not exist on KPM builds — fallback: `eips -s` or the `fbgrab` binary in `$M/koreader/tools/` if present; check `ls $M/koreader/tools` first.)

**T2.6** Walk the functional checklist on-device (Jeff taps, agent watches crash.log live via `ssh tail -f /mnt/us/koreader/crash.log` in a background terminal). Record results in `~/scribe-fix/test/CHECKLIST.md`:

| # | Action | Pass criterion |
|---|--------|----------------|
| 1 | Boot KOReader | Deck renders (not file browser) |
| 2 | Tap hero card | Reader opens last book |
| 3 | Tap Read / System | Stock file browser visible |
| 4 | Tap News | FM lands in `/mnt/us/koreader/news/` |
| 5 | Tap Notebook | Notebook UI opens |
| 6 | Tap Turntable | Model picker opens |
| 7 | Tap Bridge | InfoMessage shows base URL or "unreachable" |
| 8 | Tap SSH | InfoMessage shows tailnet info |
| 9 | Tap Reboot | ConfirmBox → clean reboot |
| 10 | KOReader menu | "Hermes Deck" entry present; start_with submenu lists it |

Any FAIL row → reproduce in stub harness → fix → `deploy.sh` → retest that row.

### Phase 3 — Fix the six suspect areas (each = test-first)

For each suspect in *Current context*, the cycle is: add a stub-harness assertion that fails → patch `hermes-deck-v3.lua` → `./check.sh` PASS → `deploy.sh` → checklist row passes → `git commit`.

- **Suspect 1 (tile taps)**: if checklist rows 2–9 fail with no crash, replace the custom `handleEvent` with KOReader's real pattern: wrap each tile in a `ButtonWidget`-style hit target or give the OverlapGroup `handleTap = true` + `onTapFunction` (verify exact field name in v2026.07.1 `frontend/ui/widget/tappablezone.lua` — fetch via `web_extract` of `https://raw.githubusercontent.com/koreader/koreader/v2026.07.1/frontend/ui/widget/tappablezone.lua`).
- **Suspect 2 (modal)**: make the deck top-level a `require("ui/widget/modalwidget")` or set `page.handleBack = true` so UIManager routes taps to it.
- **Suspect 3 (progress)**: stub `docsettings` to return `data.last_percent_complete = 0.42`; assert `ProgressWidget` appears in the UIManager show log.
- **Suspects 4–5**: verify against the pinned tag `v2026.07.1` source (raw.githubusercontent URLs above), not master — API drift between master and the installed build is a real risk.

## Tests / validation (definition of "graded functional")

1. `~/scribe-fix/check.sh` prints `GRADE: PASS` (syntax + require-smoke + all-actions-pcall-clean).
2. On-device: checklist rows 1–10 all PASS with zero new `hermes_deck` lines in `crash.log`.
3. Screenshot in `~/scribe-fix/shots/` shows the deck (vision-verified).
4. Git history shows one commit per fix (bisectable).

## Risks, tradeoffs, open questions

- **`start_with = "hermes_deck"` may be rejected by FM code** (unknown key → default view, plugin `init` still runs, so the nextTick-show should still fire — but if FM errors on unknown start_with, KOReader could fall back to last book). First on-device test (T2.3/T2.5) settles this; if broken, fallback plan is `start_with = "browser"` + our nextTick show (deck overlays the browser).
- **KOReader version drift**: all upstream source lookups must pin tag `v2026.07.1`, not master.
- **SSH plugin must be manually enabled on-device** — one-time Jeff action; if he can't reach the menu before the first reboot, T2.1 slips and Tier 2 falls back to USB crash.log pulls (`gio cat`).
- **Stub harness can't catch layout/render bugs** (font sizes, overlap, e-ink refresh) — only the screenshot + checklist catches those; that's why Tier 2 exists.
- **Open question**: does the KPM build ship `screencap`/`fbgrab`? Check `ls $M/koreader/tools` in T2.5; if absent, screenshot verification = Jeff photographs the screen, or we add `fbvnc`/VNC later (YAGNI for now).
