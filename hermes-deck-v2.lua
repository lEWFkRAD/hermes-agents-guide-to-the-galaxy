--[[
Hermes Deck v2 — themed home launcher for the Kindle Scribe.

Design goals (Jeff, 2026-10-23):
  * Clean, readable home grid — big tap targets, no clutter.
  * Every app opens the SAME way: via the Kindle booklet viewer
    (cbbOpenBook), the one launch mechanism proven on this device.
  * Notebook bridge kept, with Tailscale -> LAN fallback (probe_base).
--]]

local InfoMessage = require("ui/widget/infomessage")
local ConfirmBox = require("ui/widget/confirmbox")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local ButtonTable = require("ui/widget/buttontable")
local FrameContainer = require("ui/widget/container/framecontainer")
local CenterContainer = require("ui/widget/container/centercontainer")
local VerticalGroup = require("ui/widget/verticalgroup")
local HorizontalGroup = require("ui/widget/horizontalgroup")
local TextWidget = require("ui/widget/textwidget")
local LineWidget = require("ui/widget/linewidget")
local Screen = require("device").screen
local _ = require("gettext")
local T = require("ffi/util").template

local DECK = {}

local TS_BASE = "http://100.114.202.27:8791"
local LAN_BASE = "http://192.168.1.164:8791"
local BASE = nil -- resolved lazily

-- ---------------------------------------------------------------- bridge --

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
        local out = curl({ "-o /dev/null -w '%{http_code}' '" .. b .. "/deck'" }, 6)
        if out and out:find("200") then
            BASE = b
            return b
        end
    end
    return nil
end

-- ---------------------------------------------------------------- actions --

local function show_info(text)
    UIManager:show(InfoMessage:new{ text = text, timeout = 6 })
end

local function open_book(path)
    -- the proven launch path on this device
    os.execute("lipc-send-message -n com.lab126.booklet.center -a xbldl " ..
        "-m cbbOpenBook -t 'string' 'file://" .. path .. "' >/dev/null 2>&1")
end

local function notebook_instance()
    local ok, PluginLoader = pcall(require, "pluginloader")
    if ok and PluginLoader and PluginLoader.getPluginInstance then
        local nb = PluginLoader:getPluginInstance("notebook")
        if nb and nb.onNotebookOpen then return nb end
    end
    return nil
end

local function notebook_action()
    local nb = notebook_instance()
    if nb then
        local ok, err = pcall(nb.onNotebookOpen, nb)
        if not ok then
            show_info(_("Hermes Notebook failed to open:\n") .. tostring(err))
        end
        return
    end
    -- fallback: newest notebook file via the booklet viewer
    local p = io.popen("ls -t /mnt/us/documents/*.nbk 2>/dev/null | head -1")
    local newest = p and p:read("*l") or nil
    if p then p:close() end
    if not newest then
        show_info(_("Notebook plugin not found and no .nbk files in documents/"))
        return
    end
    open_book(newest)
end

local function bridge_action()
    local out = curl({ "-s '" .. (BASE or probe_base() or TS_BASE) .. "/deck'" }, 8)
    if out then
        show_info(T(_("Bridge OK via\n%1"), BASE))
    else
        show_info(_("Bridge unreachable on Tailscale and LAN."))
    end
end

local function turntable_action()
    local ok, PluginLoader = pcall(require, "pluginloader")
    if not ok or not PluginLoader then
        show_info(_("PluginLoader unavailable."))
        return
    end
    local tt = PluginLoader:getPluginInstance("turntable")
    if not tt or not tt.pick_and_open then
        show_info(_("Turntable plugin not loaded."))
        return
    end
    local ok2, err = pcall(tt.pick_and_open, tt)
    if not ok2 then
        show_info(_("Turntable failed to open: ") .. tostring(err))
    end
end

local function files_action()
    local ok, FileChooser = pcall(require, "ui/widget/filechooser")
    if not ok then
        show_info(_("FileChooser unavailable."))
        return
    end
    local fc = FileChooser:new{
        path = "/mnt/us",
        width = Screen:getWidth(),
        height = Screen:getHeight(),
    }
    UIManager:show(fc)
end

local function net_action()
    show_info(T(_("Tailscale IP: %1\nBridge base: %2"),
        "100.114.202.27", BASE or _("not resolved")))
end

local function reboot_action()
    UIManager:show(ConfirmBox:new{
        text = _("Restart the Kindle framework? (KOReader will close.)"),
        ok_text = _("Restart"),
        ok_callback = function()
            os.execute("stop viewer >/dev/null 2>&1; start viewer >/dev/null 2>&1 &")
        end,
    })
end

-- ------------------------------------------------------------------- home --

local function make_button(app, width)
    local h = math.floor(Screen:scaleBySize(72))
    local w = TextWidget:new{
        text = app.label,
        face = Screen:faceBidi("NotoSans"),
        size = math.floor(Screen:scaleBySize(24)),
        bold = true,
    }
    local inner = CenterContainer:new{
        dimen_h = true,
        dimen_v = true,
        w,
    }
    local frame = FrameContainer:new{
        width = width,
        height = h,
        margin = Screen:scaleBySize(6),
        bordersize = Screen:scaleBySize(2),
        inner,
    }
    return frame
end

function DECK:showHome()
    local margin = Screen:scaleBySize(16)
    local half = math.floor((Screen:getWidth() - margin * 2) / 2)
    local rows = VerticalGroup:new{ align = "center" }

    local title = TextWidget:new{
        text = "HERMES DECK",
        face = Screen:faceBidi("NotoSans"),
        size = math.floor(Screen:scaleBySize(32)),
        bold = true,
    }
    table.insert(rows, CenterContainer:new{ dimen_h = true, title })
    table.insert(rows, LineWidget:new{
        width = Screen:getWidth() - margin * 2,
        size = Screen:scaleBySize(2),
        dimen = { h = Screen:scaleBySize(2) },
    })

    for i = 1, #APPS, 2 do
        local row = HorizontalGroup:new{ align = "center" }
        for j = i, math.min(i + 1, #APPS) do
            local app = APPS[j]
            local btn = make_button(app, half)
            btn.handleTap = true
            btn.onTap = function() app.action() end
            table.insert(row, btn)
        end
        table.insert(rows, row)
    end

    local status = probe_base()
    local status_w = TextWidget:new{
        text = status and ("bridge: " .. status) or "bridge: offline",
        face = Screen:faceBidi("NotoSans"),
        size = math.floor(Screen:scaleBySize(16)),
    }
    table.insert(rows, CenterContainer:new{ dimen_h = true, status_w })

    local buttons = ButtonTable:new{
        width = Screen:getWidth(),
        buttons = {
            { { text = _("Refresh"), callback = function()
                    BASE = nil
                    UIManager:close(self.home)
                    self:showHome()
                end } },
            { { text = _("Close"), callback = function()
                    UIManager:close(self.home)
                end } },
        },
        show_parent = self.home,
    }

    self.home = CenterContainer:new{
        dimen_h = true,
        dimen_v = true,
        VerticalGroup:new{
            align = "center",
            rows,
            buttons,
        },
    }
    UIManager:show(self.home)
end

local APPS = {
    { id = "koreader", label = "KOReader",        action = function() open_book("/mnt/us/documents/KOReader.sh") end },
    { id = "notebook", label = "Notebook",        action = notebook_action },
    { id = "bridge",   label = "Hermes Bridge",   action = bridge_action },
    { id = "turntable", label = "Turntable 3D",   action = turntable_action },
    { id = "files",    label = "Files",           action = files_action },
    { id = "net",      label = "SSH / Tailscale", action = net_action },
    { id = "reboot",   label = "Clean Reboot",    action = reboot_action },
}

-- ------------------------------------------------------------- registration --

function DECK:addToMainMenu(menu_items)
    menu_items.hermes_deck = {
        text = _("Hermes Deck"),
        callback = function() self:showHome() end,
        keep_menu_open = false,
    }
end

function DECK:init()
    self.ui.menu:registerToMainMenu(self)
    -- auto-open: register a dispatcher action and fire it once the UI is up
    local ok, Dispatcher = pcall(require, "dispatcher")
    if ok and Dispatcher then
        Dispatcher:registerAction("hermes_deck_home", {
            category = "none",
            event = "HermesDeckHome",
            title = _("Open Hermes Deck"),
            general = true,
        })
    end
end

function DECK:onReaderReady()
    if self._auto_open_done then return end
    self._auto_open_done = true
    -- make sure WiFi is up so the tailscale plugin (autostart) can reach the tailnet
    local ok_net, NetworkMgr = pcall(require, "ui/network/manager")
    if ok_net and NetworkMgr and not NetworkMgr:isWifiOn() then
        pcall(function() NetworkMgr:turnOnWifi() end)
    end
    local auto = true
    local ok_s, G = pcall(function() return require("logger") and G_reader_settings end)
    pcall(function()
        local stored = G_reader_settings:readSetting("hermes_deck")
        if stored and stored.auto_open ~= nil then auto = stored.auto_open end
    end)
    if auto then
        local ok, err = pcall(function() self:showHome() end)
        if not ok then
            show_info("Hermes Deck error: " .. tostring(err))
        end
    end
end

function DECK:onHermesDeckHome()
    self._auto_open_done = false
    self:onReaderReady()
    return true
end

return { hermes_deck = DECK }
