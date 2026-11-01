--[[--
Hermes Turntable — 3D asset viewer for the Scribe.

Shows pre-rendered turntable frame sets (from the image->3D pipeline) as a
swipeable rotation:
  swipe left/right -> rotate azimuth
  tap              -> next frame (stylus friendly)
  top-right        -> close

Assets live at /mnt/us/turntable/<name>/frame_NNN.png + meta.json.

@module koplugin.Turntable
--]]

local Device = require("device")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
local ImageWidget = require("ui/widget/imagewidget")
local json = require("json")
local LineWidget = require("ui/widget/linewidget")
local logger = require("logger")
local TextWidget = require("ui/widget/textwidget")
local Font = require("ui/font")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local Menu = require("ui/widget/menu")
local _ = require("gettext")
local Screen = Device.screen

local ASSET_DIR = "/mnt/us/turntable"

local TURNTABLE = WidgetContainer:extend({
    name = "turntable",
    is_doc_only = false,
})

-- ---- asset discovery ------------------------------------------------------
local function list_assets()
    local assets = {}
    local p = io.popen("ls -1 " .. ASSET_DIR .. " 2>/dev/null")
    if not p then return assets end
    for name in p:lines() do
        local meta_path = ASSET_DIR .. "/" .. name .. "/meta.json"
        local f = io.open(meta_path, "r")
        if f then
            local body = f:read("*a")
            f:close()
            local ok, meta = pcall(json.decode, body)
            if ok and meta and meta.frames and meta.frames > 0 then
                table.insert(assets, { name = name, meta = meta })
            end
        end
    end
    return assets
end

-- ---- viewer ---------------------------------------------------------------
function TURNTABLE:build_view()
    local SW, SH = Screen:getWidth(), Screen:getHeight()
    local bar_h = Screen:scaleBySize(36)

    local avail_w, avail_h = SW, SH - bar_h
    local fw, fh = self.meta.width or avail_w, self.meta.height or avail_h
    local scale = math.min(avail_w / fw, avail_h / fh)
    local iw, ih = math.floor(fw * scale), math.floor(fh * scale)
    self.img_x = math.floor((SW - iw) / 2)
    self.img_y = bar_h + math.floor((avail_h - ih) / 2)
    self.img_w, self.img_h = iw, ih

    local step = self.meta.azimuth_step or 15
    local az = (self.idx - 1) * step
    local status = string.format("%s  ·  az %03d°  ·  swipe/tap to rotate  ·  ✕ top-right",
        self.asset_name, az % 360)

    local bar = WidgetContainer:new{
        TextWidget:new{
            text = status,
            face = Font:getFace("infofont", 16),
        },
        LineWidget:new{
            dimen = Geom:new{ w = SW, h = 2 },
        },
    }
    self.bar = bar

    local img = ImageWidget:new{
        file = self.frames[self.idx],
        file_do_cache = false,
        width = iw,
        height = ih,
    }
    self.img = img

    local view = InputContainer:new{
        dimen = Geom:new{ x = 0, y = 0, w = SW, h = SH },
        ges_events = {
            Tap = { GestureRange:new{ ges = "tap", range = Geom:new{ x = 0, y = 0, w = SW, h = SH } } },
            Swipe = { GestureRange:new{ ges = "swipe", range = Geom:new{ x = 0, y = 0, w = SW, h = SH } } },
        },
        WidgetContainer:new{
            bar,
            WidgetContainer:new{
                dimen = Geom:new{ x = self.img_x, y = self.img_y, w = iw, h = ih },
                img,
            },
        },
        onTap = function(_, _, ges)
            if ges.pos.y < bar_h and ges.pos.x > SW - Screen:scaleBySize(220) then
                self:close()
                return true
            end
            self:step(1)
            return true
        end,
        onSwipe = function(_, _, ges)
            if ges.direction == "left" then
                self:step(1)
            elseif ges.direction == "right" then
                self:step(-1)
            end
            return true
        end,
    }
    return view
end

function TURNTABLE:rebuild()
    local old = self.view
    self.view = self:build_view()
    if old then UIManager:close(old) end
    UIManager:show(self.view, "full")
end

-- In-place image swap: no close/show cycle, no e-ink teardown flash.
function TURNTABLE:refresh_image()
    if self.view and self.img then
        local step = self.meta.azimuth_step or 15
        local az = (self.idx - 1) * step
        -- swap the status TextWidget inside the bar container in place
        if self.bar then
            self.bar:free()
            self.bar[1] = TextWidget:new{
                text = string.format("%s  ·  az %03d°  ·  swipe/tap to rotate  ·  ✕ top-right",
                    self.asset_name, az % 360),
                face = Font:getFace("infofont", 16),
            }
            self.bar:free()
            self.bar:_render()
        end
        local ok, err = pcall(function()
            self.img:free()
            self.img.file = self.frames[self.idx]
            self.img:_loadfile()
            self.img:_render()
        end)
        if not ok then
            logger.warn("turntable: image refresh failed:", err)
        end
        UIManager:setDirty(self.view, "partial")
    else
        self:rebuild()
    end
end

function TURNTABLE:step(d)
    self.idx = ((self.idx - 1 + d) % #self.frames) + 1
    self:refresh_image()
end

-- ---- open / close ---------------------------------------------------------
function TURNTABLE:open(asset_name, meta)
    self.asset_name = asset_name
    self.meta = meta
    self.frames = {}
    local step = meta.azimuth_step or 15
    for i = 0, meta.frames - 1 do
        table.insert(self.frames, string.format("%s/%s/frame_%03d.png", ASSET_DIR, asset_name, (i * step) % 360))
    end
    self.idx = 1
    self:rebuild()
end

function TURNTABLE:close()
    if self.view then
        UIManager:close(self.view)
        self.view = nil
    end
    self.img = nil
    self.status_text = nil
end

function TURNTABLE:pick_and_open()
    local assets = list_assets()
    if #assets == 0 then
        UIManager:show(require("ui/widget/textviewer"):new{
            title = _("Hermes Turntable"),
            text = _("No assets found.\n\nPut turntable frame sets in\n/mnt/us/turntable/<name>/\n(each needs a meta.json)."),
        })
        return
    end
    if #assets == 1 then
        self:open(assets[1].name, assets[1].meta)
        return
    end
    local items = {}
    for _, a in ipairs(assets) do
        table.insert(items, {
            text = a.name,
            subtext = string.format("%d frames", a.meta.frames),
            callback = function()
                UIManager:close(menu)
                self:open(a.name, a.meta)
            end,
        })
    end
    local menu
    menu = Menu:new{
        title = _("Turntable assets"),
        item_table = items,
        width = Screen:scaleBySize(600),
        height = Screen:scaleBySize(800),
    }
    UIManager:show(menu)
end

-- ---- registration ---------------------------------------------------------
function TURNTABLE:addToMainMenu(menu_items)
    menu_items.turntable = {
        text = _("Hermes Turntable"),
        sorting_hint = "tools",
        callback = function()
            local ok, err = pcall(function() self:pick_and_open() end)
            if not ok then
                UIManager:show(require("ui/widget/textviewer"):new{
                    title = _("Hermes Turntable error"),
                    text = tostring(err),
                })
            end
        end,
        keep_menu_open = false,
    }
end

function TURNTABLE:init()
    self.ui.menu:registerToMainMenu(self)
end

return TURNTABLE
