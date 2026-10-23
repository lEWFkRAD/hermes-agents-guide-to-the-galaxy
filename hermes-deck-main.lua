--[[--
Hermes Deck — custom home dashboard for the Scribe.

Opens automatically at KOReader startup: recent books, Hermes Notebook,
file manager, battery/status line. Toggle auto-open from its Settings row.

Verified against KOReader v2026.07.1 on the Scribe:
  * menu registration = addToMainMenu(menu_items)  (filemanagermenu.lua:881)
  * open a book       = filemanagerutil.openFile(ui, file)
  * battery           = Device.powerd:getCapacity()
  * history           = plain Lua table at /mnt/us/koreader/history.lua

@module koplugin.Dashboard
--]]

local Device = require("device")
local FileChooser = require("ui/widget/filechooser")
local Menu = require("ui/widget/menu")
local PluginLoader = require("pluginloader")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local filemanagerutil = require("apps/filemanager/filemanagerutil")
local logger = require("logger")
local _ = require("gettext")
local Screen = Device.screen

local SETTINGS_KEY = "hermes_deck"
local HISTORY_FILE = "/mnt/us/koreader/history.lua"
local DEFAULTS = {
    auto_open = true,
    recent_count = 8,
}

local DECK = WidgetContainer:extend({
    name = "hermes_deck",
    is_doc_only = false,
})

local function cfg()
    local t = G_reader_settings:readSetting(SETTINGS_KEY) or {}
    for k, v in pairs(DEFAULTS) do
        if t[k] == nil then t[k] = v end
    end
    return t
end

local function save_cfg(t)
    G_reader_settings:saveSetting(SETTINGS_KEY, t)
end

-- ---- status line ----------------------------------------------------------
function DECK:statusline()
    local parts = { os.date("%a %H:%M") }
    local ok, level = pcall(function() return Device.powerd:getCapacity() end)
    if ok and level then
        local charging = false
        local ok2, ch = pcall(function() return Device.powerd:isCharging() end)
        if ok2 and ch then charging = true end
        table.insert(parts, string.format("%d%%", level) .. (charging and " (charging)" or ""))
    end
    return table.concat(parts, "   |   ")
end

-- ---- unread Hermes replies -------------------------------------------------
local function bridge_get_session()
    local nb = {}
    pcall(function() nb = G_reader_settings:readSetting("notebook") or {} end)
    local base = nb.base or "http://100.114.202.27:8791"
    local key = nb.key or "v-iuzzwayKGzAng4-IeDmHQE"
    local sid = nb.session_id or ""
    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local json = require("json")
    http.TIMEOUT = 5
    local function get(url)
        local body = {}
        local ok, code = http.request({
            url = url,
            method = "GET",
            headers = {
                ["x-diary-remote-key"] = key,
                ["accept"] = "application/json",
            },
            sink = ltn12.sink.table(body),
        })
        if not ok or code ~= 200 then return nil end
        local ok2, parsed = pcall(json.decode, table.concat(body))
        return ok2 and parsed or nil
    end
    if sid == "" then
        -- same fallback the notebook uses: first session in the list
        local list = get(base .. "/api/sessions")
        local sessions = list and (list.sessions or list) or {}
        local first = sessions[1]
        sid = first and (first.id or first.session_id) or ""
        if sid == "" then return nil end
    end
    local parsed = get(base .. "/api/sessions/" .. sid)
    if parsed and parsed.session then return parsed.session.messages end
    return nil
end

function DECK:badge_unread()
    if not self.deck or not self.nb_item then return end
    local msgs = bridge_get_session()
    if not msgs then return end
    self._last_total = #msgs
    local seen = cfg().seen_msg_count or 0
    local unread = 0
    for i, m in ipairs(msgs) do
        if i > seen and m.role == "assistant" then unread = unread + 1 end
    end
    if unread > 0 then
        self.nb_item.mandatory = _("agent") .. "  ● " .. unread
        self.deck:updateItems()
    end
end

function DECK:mark_read()
    local t = cfg()
    t.seen_msg_count = self._last_total or 0
    save_cfg(t)
end

-- ---- recent books ---------------------------------------------------------
local DOC_EXT = { pdf=1, epub=1, mobi=1, azw3=1, prc=1, fb2=1, txt=1, md=1,
                  doc=1, docx=1, rtf=1, djvu=1, cbr=1, cbz=1, chm=1, lit=1,
                  xps=1, odp=1, odt=1, ppt=1, pptx=1, xls=1, xlsx=1 }

function DECK:recent_items()
    local out = {}
    local chunk, err = loadfile(HISTORY_FILE)
    if not chunk then
        logger.warn("hermes_deck: cannot load history:", err)
        return out
    end
    local ok, items = pcall(chunk)
    if not ok or type(items) ~= "table" then return out end
    local list = {}
    for _, it in pairs(items) do
        if type(it) == "table" and it.file then table.insert(list, it) end
    end
    table.sort(list, function(a, b) return (a.time or 0) > (b.time or 0) end)
    for _, it in ipairs(list) do
        local f = it.file
        local ext = f:match("%.([%w]+)$")
        if ext and DOC_EXT[ext:lower()] then
            local name = f:match("([^/]+)$") or f
            table.insert(out, {
                text = name,
                mandatory = it.time and os.date("%m-%d %H:%M", it.time) or "",
                callback = function()
                    UIManager:close(self.deck)
                    filemanagerutil.openFile(self.ui, f)
                end,
            })
            if #out >= cfg().recent_count then break end
        end
    end
    return out
end

-- ---- actions --------------------------------------------------------------
function DECK:open_notebook()
    local nb = PluginLoader:getPluginInstance("notebook")
    if nb and nb.open then
        self:mark_read()
        UIManager:close(self.deck)
        local ok, err = pcall(nb.open, nb)
        if not ok then
            logger.warn("hermes_deck: notebook open failed:", tostring(err))
            local InfoMessage = require("ui/widget/infomessage")
            UIManager:show(InfoMessage:new{
                text = _("Hermes Notebook failed to open:\n") .. tostring(err),
            })
        end
    else
        logger.warn("hermes_deck: notebook plugin instance not found")
    end
end

function DECK:open_files()
    UIManager:close(self.deck)
    local fc = FileChooser:new{
        path = "/mnt/us",
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        ui = self.ui,
    }
    UIManager:show(fc)
end

function DECK:settings()
    local item_table = {
        {
            text = _("Open deck at startup"),
            switch = cfg().auto_open and "on" or "off",
            callback = function() end,
            postCallback = function(toggled)
                local t = cfg()
                t.auto_open = toggled
                save_cfg(t)
            end,
        },
    }
    local m = Menu:new{
        title = _("Deck settings"),
        item_table = item_table,
        width = math.floor(Screen:getWidth() * 0.7),
        height = math.floor(Screen:getHeight() * 0.5),
        ui = self.ui,
    }
    UIManager:show(m)
end

-- ---- the deck itself ------------------------------------------------------
function DECK:show()
    local items = {}
    for _, it in ipairs(self:recent_items()) do
        table.insert(items, it)
    end
    self.nb_item = {
        text = _("Hermes Notebook"),
        mandatory = _("agent"),
        callback = function() self:open_notebook() end,
    }
    table.insert(items, self.nb_item)
    table.insert(items, {
        text = _("Hermes Remote"),
        mandatory = _("desktop"),
        callback = function()
            logger.info("DECK: Hermes Remote button pressed")
            local ok, err = pcall(function()
                local remote = require("pluginloader").loaded_plugins["remote"]
                if not remote or not remote.open then
                    error(_("remote plugin not loaded"))
                end
                remote:open()
            end)
            if not ok then
                logger.info("DECK: remote open failed:", tostring(err))
                UIManager:show(require("ui/widget/infomessage"):new{
                    text = _("Remote failed to open: ") .. tostring(err),
                })
            end
        end,
    })
    table.insert(items, {
        text = _("Hermes Turntable"),
        mandatory = _("3D"),
        callback = function()
            logger.info("DECK: Hermes Turntable button pressed")
            local ok, err = pcall(function()
                local tt = PluginLoader:getPluginInstance("turntable")
                if not tt or not tt.pick_and_open then
                    error(_("turntable plugin not loaded"))
                end
                tt:pick_and_open()
            end)
            if not ok then
                logger.info("DECK: turntable open failed:", tostring(err))
                UIManager:show(require("ui/widget/infomessage"):new{
                    text = _("Turntable failed to open: ") .. tostring(err),
                })
            end
        end,
    })
    table.insert(items, {
        text = _("Files"),
        mandatory = "/mnt/us",
        callback = function() self:open_files() end,
    })
    table.insert(items, {
        text = _("Deck settings"),
        callback = function() self:settings() end,
    })

    self.deck = Menu:new{
        title = _("Hermes Deck"),
        subtitle = self:statusline(),
        item_table = items,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        items_per_page = 12,
        single_line = false,
        ui = self.ui,
    }
    UIManager:show(self.deck)
    -- fetch unread Hermes replies just after the deck paints
    UIManager:scheduleIn(0.3, function()
        local ok, err = pcall(function() self:badge_unread() end)
        if not ok then logger.info("DECK: badge fetch failed:", tostring(err)) end
    end)
end

-- ---- registration ---------------------------------------------------------
function DECK:addToMainMenu(menu_items)
    menu_items.hermes_deck = {
        text = _("Hermes Deck"),
        sorting_hint = "tools",
        callback = function()
            self:show()
        end,
        keep_menu_open = false,
    }
end

function DECK:init()
    self.ui.menu:registerToMainMenu(self)
    if cfg().auto_open then
        UIManager:scheduleIn(1.0, function()
            self:show()
        end)
    end
end

return DECK
