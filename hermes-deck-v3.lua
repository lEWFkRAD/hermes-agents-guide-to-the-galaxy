--[[
Hermes Deck v3 — home-screen takeover for the Kindle Scribe.

Replaces KOReader's file-manager landing with a full-screen deck:
  * status strip: time, battery, WiFi/bridge state
  * hero card: continue reading (last book, progress bar, one tap to open)
  * big sharp app tiles (3 columns)
  * System tile opens stock KOReader file browser

Takeover mechanism (verified against KOReader source + bookshelf.koplugin):
  * start_with setting == "hermes_deck" -> on FileManager init (plugin loads
    there), close nothing; instead swap the FM's content: show deck as a
    fullscreen widget on top, and suppress the file list until dismissed.
  * "System" tile closes the deck -> stock file browser underneath.
--]]

local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local FrameContainer = require("ui/widget/container/framecontainer")
local CenterContainer = require("ui/widget/container/centercontainer")
local LeftContainer = require("ui/widget/container/leftcontainer")
local RightContainer = require("ui/widget/container/rightcontainer")
local VerticalGroup = require("ui/widget/verticalgroup")
local HorizontalGroup = require("ui/widget/horizontalgroup")
local TextWidget = require("ui/widget/textwidget")
local LineWidget = require("ui/widget/linewidget")
local ProgressWidget = require("ui/widget/progresswidget")
local OverlapGroup = require("ui/widget/overlapgroup")
local Screen = require("device").screen
local Device = require("device")
local Font = require("ui/font")
local _ = require("gettext")
local T = require("ffi/util").template
local DateTime = require("datetime")

local DECK = WidgetContainer:extend{
    name = "hermes_deck",
    is_doc_only = false,
    _APPS = nil,  -- populated below; exposed for the test harness
}

local TS_BASE = "http://100.114.202.27:8791"
local LAN_BASE = "http://192.168.1.164:8791"
local BASE = nil

-- ---------------------------------------------------------------- helpers --

local function curl(args, timeout)
    local ok = os.execute(
        string.format("timeout %d curl -s -m %d %s > /tmp/hermes_deck_out 2>/dev/null",
            timeout + 2, timeout, table.concat(args, " ")))
    if not ok then return nil end
    local f = io.open("/tmp/hermes_deck_out", "r")
    if not f then return nil end
    local out = f:read("*a") or ""
    f:close()
    os.remove("/tmp/hermes_deck_out")
    if out == "" then return nil end
    return out
end

local function probe_base()
    if BASE then return BASE end
    for _, b in ipairs({ TS_BASE, LAN_BASE }) do
        local out = curl({ "-o /dev/null -w '%{http_code}' '" .. b .. "/deck'" }, 5)
        if out and out:find("200") then
            BASE = b
            return b
        end
    end
    return nil
end

local function show_info(text)
    local InfoMessage = require("ui/widget/infomessage")
    UIManager:show(InfoMessage:new{ text = text, timeout = 6 })
end

local function notebook_action()
    local PluginLoader = require("pluginloader")
    local ok, inst = pcall(function()
        return PluginLoader:loadPlugins() and PluginLoader:getPluginInstance("notebook")
    end)
    if ok and inst and inst.onNotebookOpen then
        pcall(function() inst:onNotebookOpen() end)
    else
        show_info(_("Hermes Notebook not available."))
    end
end

local function bridge_action()
    local b = probe_base()
    if b then
        show_info(T(_("Bridge OK via\n%1"), b))
    else
        show_info(_("Bridge unreachable on Tailscale and LAN."))
    end
end

local function turntable_action()
    local PluginLoader = require("pluginloader")
    local ok, inst = pcall(function()
        return PluginLoader:loadPlugins() and PluginLoader:getPluginInstance("turntable")
    end)
    if ok and inst and inst.pick_and_open then
        pcall(function() inst:pick_and_open() end)
    else
        show_info(_("Turntable plugin not available."))
    end
end

local function files_action()
    -- stock KOReader file browser: just close the deck
    DECK:closeDeck()
end

local function net_action()
    show_info(T(_("Scribe tailnet IP: 100.73.123.24\nSSH port: 2222 (start SSH plugin first)\nBridge base: %1"),
        probe_base() or "none"))
end

local function reboot_action()
    local ConfirmBox = require("ui/widget/confirmbox")
    UIManager:show(ConfirmBox:new{
        text = _("Clean reboot the Kindle?"),
        ok_text = _("Reboot"),
        ok_callback = function()
            os.execute("lipc-set-prop com.lab126.powerd powerOff 1 2>/dev/null &")
        end,
    })
end

local function news_action()
    -- open the news folder in the stock browser
    DECK:closeDeck()
    UIManager:nextTick(function()
        local FileManager = require("apps/filemanager/filemanager")
        if FileManager.instance and FileManager.instance.file_chooser then
            FileManager.instance.file_chooser:changeToPath("/mnt/us/koreader/news/")
        end
    end)
end

-- ------------------------------------------------------------- tile widget --

local function make_tile(label, sub, action, w, h)
    local TextWidget2 = TextWidget
    local inner = VerticalGroup:new{
        align = "center",
        TextWidget2:new{
            text = label,
            face = Font:getFace("cfont", 24),
            bold = true,
        },
        TextWidget2:new{
            text = sub or "",
            face = Font:getFace("smallinfofont", 14),
            dim = true,
        },
    }
    local frame = FrameContainer:new{
        width = w,
        height = h,
        margin = Screen:scaleBySize(10),
        bordersize = Screen:scaleBySize(2),
        color = 0,
        background = false,
        CenterContainer:new{ dimen_h = true, dimen_v = true, inner },
    }
    frame.overlapGroup = nil
    local wdg = OverlapGroup:new{ dimen = { w = w, h = h }, frame }
    wdg.handleEvent = function(self, event)
        if event.type == "Tap" and event.ges and event.ges.gesture == "F1" then
            action()
            return true
        end
        return false
    end
    wdg.handleTap = true
    wdg.onTap = function() action() end
    return wdg
end

-- ------------------------------------------------------------------ deck --

local APPS = {
    { label = "Read",        sub = "KOReader library",  action = files_action },
    { label = "News",        sub = "downloaded feeds",  action = news_action },
    { label = "Notebook",    sub = "Hermes bridge",     action = notebook_action },
    { label = "Turntable",   sub = "3D models",         action = turntable_action },
    { label = "Bridge",      sub = "test connection",   action = bridge_action },
    { label = "SSH",         sub = "tailnet info",      action = net_action },
    { label = "System",      sub = "stock KOReader",    action = function() DECK:closeDeck() end },
    { label = "Reboot",      sub = "clean power off",   action = reboot_action },
}
DECK._APPS = APPS

function DECK:heroCard(w)
    local ok, ReadHistory = pcall(require, "readhistory")
    local last = nil
    if ok and ReadHistory and ReadHistory.history then
        for i = #ReadHistory.history, 1, -1 do
            local item = ReadHistory.history[i]
            if item and item.text then last = item; break end
        end
    end
    local group = VerticalGroup:new{ align = "left" }
    if last then
        table.insert(group, TextWidget:new{
            text = _("Continue reading"),
            face = Font:getFace("smallinfofont", 14),
            dim = true,
        })
        table.insert(group, TextWidget:new{
            text = last.text:gsub("%.epub$", ""):gsub("%.pdf$", ""):gsub("%.txt$", ""),
            face = Font:getFace("cfont", 22),
            bold = true,
            width = w - Screen:scaleBySize(24),
        })
        local pct = nil
        pcall(function()
            local DocSettings = require("docsettings")
            local dd = DocSettings:open(last.text)
            if dd then
                pct = dd.data and dd.data.last_percent_complete
            end
        end)
        if pct then
            table.insert(group, ProgressWidget:new{
                width = w - Screen:scaleBySize(24),
                height = Screen:scaleBySize(8),
                percentage = pct,
                margin = 0,
                tick_lef = false, tick_right = false, tick_marks = false,
            })
        end
    else
        table.insert(group, TextWidget:new{
            text = _("No books yet — drop EPUBs into /books"),
            face = Font:getFace("cfont", 20),
            dim = true,
        })
    end
    local frame = FrameContainer:new{
        width = w,
        margin = Screen:scaleBySize(12),
        bordersize = Screen:scaleBySize(2),
        color = 0,
        group,
    }
    local wdg = OverlapGroup:new{ dimen = { w = w }, frame }
    wdg.handleTap = true
    wdg.onTap = function()
        if last then
            local ReaderUI = require("apps/reader/readerui")
            pcall(function() ReaderUI:showReader(last.text) end)
        end
    end
    return wdg
end

function DECK:statusStrip(w)
    local row = HorizontalGroup:new{ align = "center" }
    local time_s = os.date("%H:%M")
    local batt = ""
    pcall(function()
        local bs = Device:batteryInfo()
        if bs and bs.percentage then batt = string.format("battery %d%%", bs.percentage) end
    end)
    local bridge = probe_base() and "bridge OK" or "bridge offline"
    local left = TextWidget:new{
        text = T(_("%1  ·  %2  ·  %3"), time_s, batt, bridge),
        face = Font:getFace("smallinfofont", 15),
    }
    local right = TextWidget:new{
        text = "HERMES DECK",
        face = Font:getFace("cfont", 18),
        bold = true,
    }
    local strip = OverlapGroup:new{ dimen = { w = w, h = Screen:scaleBySize(36) } }
    table.insert(strip, LeftContainer:new{ dimen_h = true, left })
    table.insert(strip, RightContainer:new{ dimen_h = true, right })
    return strip
end

function DECK:showDeck()
    if self._view then return end
    local W = Screen:getWidth()  -- noqa: shadows nothing; width in px
    local margin = Screen:scaleBySize(18)
    local inner_w = W - margin * 2

    local rows = VerticalGroup:new{ align = "center" }
    table.insert(rows, self:statusStrip(inner_w))
    table.insert(rows, LineWidget:new{
        width = inner_w, size = Screen:scaleBySize(2),
        dimen = { h = Screen:scaleBySize(2) },
    })
    table.insert(rows, self:heroCard(inner_w))
    table.insert(rows, LineWidget:new{
        width = inner_w, size = Screen:scaleBySize(1),
        dimen = { h = Screen:scaleBySize(1) },
    })

    local cols = 3
    local gap = Screen:scaleBySize(10)
    local tile_w = math.floor((inner_w - gap * (cols - 1)) / cols)
    local tile_h = Screen:scaleBySize(150)
    for i = 1, #APPS, cols do
        local row = HorizontalGroup:new{ align = "center" }
        for j = i, math.min(i + cols - 1, #APPS) do
            local app = APPS[j]
            table.insert(row, make_tile(app.label, app.sub, app.action, tile_w, tile_h))
            if j < math.min(i + cols - 1, #APPS) then
                table.insert(row, require("ui/widget/blankwidget"):new{ width = gap, height = 1 })
            end
        end
        table.insert(rows, row)
        table.insert(rows, require("ui/widget/blankwidget"):new{ width = 1, height = gap })
    end

    local content = CenterContainer:new{ dimen_h = true, rows }
    local page = FrameContainer:new{
        width = W,
        height = Screen:getHeight(),
        margin = 0,
        bordersize = 0,
        background = true,
        content,
    }
    self._view = page
    UIManager:show(page)
    UIManager:setDirty(nil, "full")
end

function DECK:closeDeck()
    if self._view then
        UIManager:close(self._view)
        self._view = nil
        UIManager:setDirty(nil, "partial")
    end
end

-- ------------------------------------------------------------- takeover ----

function DECK:init()
    self.ui.menu:registerToMainMenu(self)
    if G_reader_settings:readSetting("start_with") == "hermes_deck"
       and self.ui and not self.ui.document then
        -- we are in the FileManager context at startup
        UIManager:nextTick(function() self:showDeck() end)
    end
end

function DECK:addToMainMenu(menu_items)
    menu_items.hermes_deck = {
        text = _("Hermes Deck"),
        callback = function() self:showDeck() end,
        keep_menu_open = false,
    }
    -- add "Hermes Deck" to the start_with choices
    if not menu_items.start_with then return end
    local sub = menu_items.start_with.sub_item_table
    if sub then
        for _, it in ipairs(sub) do
            if it.name == "hermes_deck" then return end
        end
        table.insert(sub, {
            text = _("Hermes Deck"),
            name = "hermes_deck",
            checked_func = function()
                return G_reader_settings:readSetting("start_with") == "hermes_deck"
            end,
            callback = function()
                G_reader_settings:saveSetting("start_with", "hermes_deck")
            end,
            radio = true,
        })
    end
end

-- patch the start_with menu table at class level so our entry is always there
local ok_menu, FileManagerMenu = pcall(require, "apps/filemanager/filemanagermenu")
if ok_menu and FileManagerMenu and not FileManagerMenu._deck_patched then
    FileManagerMenu._deck_patched = true
    local orig = FileManagerMenu.getStartWithMenuTable
    FileManagerMenu.getStartWithMenuTable = function(self)
        local tbl = orig(self)
        for _, it in ipairs(tbl) do
            if it.name == "hermes_deck" then return tbl end
        end
        table.insert(tbl, {
            text = _("Hermes Deck"),
            name = "hermes_deck",
            checked_func = function()
                return G_reader_settings:readSetting("start_with") == "hermes_deck"
            end,
            callback = function()
                G_reader_settings:saveSetting("start_with", "hermes_deck")
            end,
            radio = true,
        })
        return tbl
    end
end

return { hermes_deck = DECK }
