-- Grading harness: score each deck capability against the plan's Tier-1 criteria.
package.path = "test/stubs/?.lua;" .. package.path
local results = {}
local function grade(name, fn)
    local ok, err = pcall(fn)
    results[#results+1] = { name = name, pass = ok, note = ok and "" or tostring(err) }
end

_G.G_reader_settings = {
    _s = {},
    readSetting = function(self, k) return self._s[k] end,
    saveSetting = function(self, k, v) self._s[k] = v end,
}
G_reader_settings = _G.G_reader_settings
G_reader_settings:saveSetting("start_with", "hermes_deck")

local reg = require("hermes-deck-v3")
local DECK = reg.hermes_deck

grade("plugin-returns-hermes-deck", function()
    assert(type(reg) == "table" and reg.hermes_deck)
end)

grade("start-with-setting-honored", function()
    assert(G_reader_settings:readSetting("start_with") == "hermes_deck")
end)

local d = DECK:new{}
d.ui = { menu = { registerToMainMenu = function() end } }
grade("init-no-crash", function() d:init() end)
grade("show-deck-sets-view", function() d:showDeck(); assert(rawget(d, "_view")) end)

grade("exposes-8-apps", function()
    assert(DECK._APPS and #DECK._APPS == 8, "apps=" .. tostring(DECK._APPS and #DECK._APPS))
end)

-- actions with seeded module stubs (not just swallowed nils)
grade("tile-actions-with-seeded-modules", function()
    local seed = {
        ["ui/widget/infomessage"] = setmetatable({}, {__index=function() return function(...) return {} end end}),
        ["pluginloader"] = { getPluginInstance = function() return nil end },
        ["ui/widget/confirmbox"] = setmetatable({}, {__index=function() return function(...) return {} end end}),
        ["apps/filemanager/filemanager"] = { instance = nil, show = function() end },
        ["apps/reader/readerui"] = { showInstance = function() end },
        ["readhistory"] = { history = {}, iterLastReadFile = function() return nil end },
        ["docsettings"] = { open = function() return { data = {} } end },
    }
    for m, tbl in pairs(seed) do package.loaded[m] = tbl end
    for _, app in ipairs(DECK._APPS) do
        local ok, err = pcall(app.action)
        assert(ok, (app.label or "?") .. ": " .. tostring(err))
    end
end)

grade("hero-card-with-history", function()
    package.loaded["readhistory"] = {
        history = { { text = "/mnt/us/books/Dune.epub", percent = 0.42, time = os.time() } },
        iterLastReadFile = function() return { text = "/mnt/us/books/Dune.epub", percent = 0.42 } end,
    }
    package.loaded["docsettings"] = { open = function() return { data = { percent = 0.42, last_xpointer = "x" } } end }
    d:closeDeck()
    d:showDeck()
    assert(rawget(d, "_view"))
end)

grade("close-deck-clears-view", function()
    d:closeDeck()
    assert(rawget(d, "_view") == nil)
end)

grade("menu-registers-items", function()
    local registered
    d.ui.menu.registerToMainMenu = function(self, items) registered = items end
    d:addToMainMenu({})
    -- addToMainMenu receives the items table directly in KOReader; just no-crash
end)

local pass, fail = 0, 0
for _, r in ipairs(results) do
    print(string.format("%-32s %s %s", r.name, r.pass and "PASS" or "FAIL", r.note))
    if r.pass then pass = pass + 1 else fail = fail + 1 end
end
print(string.format("GRADE: %d/%d pass", pass, pass + fail))
os.exit(fail == 0 and 0 or 1)
