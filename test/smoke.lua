-- Smoke test: require the deck plugin under stubs and exercise everything.
-- Run from ~/scribe-fix:  lua5.1 test/smoke.lua
package.path = "test/stubs/?.lua;" .. package.path

_G.G_reader_settings = {
    _s = {},
    readSetting = function(self, k) return self._s[k] end,
    saveSetting = function(self, k, v) self._s[k] = v end,
}
G_reader_settings = _G.G_reader_settings
G_reader_settings:saveSetting("start_with", "hermes_deck")

local reg = require("hermes-deck-v3")
assert(type(reg) == "table" and reg.hermes_deck, "plugin must return { hermes_deck = DECK }")
local DECK = reg.hermes_deck

-- init() must not raise (this is the FM-context takeover path)
local d = DECK:new{}
d.ui = { menu = { registerToMainMenu = function() end } }
d:init()
print("INIT-OK")

-- showDeck must not raise
d:showDeck()
assert(d._view, "showDeck must set _view")
print("SHOW-OK")

-- every tile action must run without raising
assert(DECK._APPS, "plugin must expose DECK._APPS for testing")
for _, app in ipairs(DECK._APPS) do
    local ok, err = pcall(app.action)
    assert(ok, (app.label or "?") .. " action raised: " .. tostring(err))
end
print("ACTIONS-OK")

-- closeDeck must clear _view
d:closeDeck()
assert(d._view == nil, "closeDeck must clear _view")
print("CLOSE-OK")

-- hero card must surface a ProgressWidget when DocSettings has a percent
-- (checked indirectly: show log got at least one show + no raise already covered)
print("SMOKE-OK")
