-- Hermes Notebook: native KOReader client for the Shatner notebook bridge.
-- v2: page-first mirror of the Live Page app (hermes-agents-guide-to-the-galaxy):
--     current page under a writing layer, New / Pen / Send / Redline / Pages.
local ButtonTable = require("ui/widget/buttontable")
local CenterContainer = require("ui/widget/container/centercontainer")
local FrameContainer = require("ui/widget/container/framecontainer")
local HtmlBoxWidget = require("ui/widget/htmlboxwidget")
local ImageWidget = require("ui/widget/imagewidget")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local LineWidget = require("ui/widget/linewidget")
local Menu = require("ui/widget/menu")
local TextWidget = require("ui/widget/textwidget")
local TextViewer = require("ui/widget/textviewer")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local Font = require("ui/font")
local Screen = require("device").screen
local Geom = require("ui/geometry")
local _ = require("gettext")
local T = require("ffi/util").template
local json = require("json")

local http = require("socket.http")
local ltn12 = require("ltn12")

local NOTEBOOK = WidgetContainer:extend({
    name = "notebook",
    is_doc_only = false,
})

local DEFAULT_BASE = "http://100.114.202.27:8791"
local LAN_BASE = "http://192.168.1.164:8791"  -- Onyx-Linux on the home LAN; used when the Tailscale IP is unreachable
local DEFAULT_KEY = "v-iuzzwayKGzAng4-IeDmHQE"
local INK_DIR = "/mnt/us/koreader/notebook"
local INK_PATH = INK_DIR .. "/ink.png"

function NOTEBOOK:cfg()
    if not self._cfg then
        local stored = {}
        local ok, s = pcall(function() return G_reader_settings:readSetting("notebook") end)
        if ok and s then stored = s end
        self._cfg = {
            base = stored.base or DEFAULT_BASE,
            key = stored.key or DEFAULT_KEY,
            session_id = stored.session_id or "",
        }
    end
    return self._cfg
end

function NOTEBOOK:save_cfg()
    pcall(function() G_reader_settings:saveSetting("notebook", self._cfg) end)
end

-- ---- base64 ---------------------------------------------------------------
local B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function b64(data)
    local out = {}
    for i = 1, #data, 3 do
        local a = data:byte(i)
        local b = data:byte(i + 1)
        local c = data:byte(i + 2)
        local n = a * 65536 + (b or 0) * 256 + (c or 0)
        local chunk = B64CHARS:sub(math.floor(n / 262144) % 64 + 1, math.floor(n / 262144) % 64 + 1)
            .. B64CHARS:sub(math.floor(n / 4096) % 64 + 1, math.floor(n / 4096) % 64 + 1)
        if b then
            chunk = chunk .. B64CHARS:sub(math.floor(n / 64) % 64 + 1, math.floor(n / 64) % 64 + 1)
            if c then
                chunk = chunk .. B64CHARS:sub(n % 64 + 1, n % 64 + 1)
            else
                chunk = chunk .. "="
            end
        else
            chunk = chunk .. "=="
        end
        out[#out + 1] = chunk
    end
    return table.concat(out)
end

-- ---- http -----------------------------------------------------------------
local _base_override

local function probe_base(base)
    if base == _base_override then return true end
    local probe = {}
    http.TIMEOUT = 4
    local ok = http.request({
        url = base .. "/",
        method = "GET",
        headers = { ["x-diary-remote-key"] = key, ["accept"] = "application/json" },
        sink = ltn12.sink.table(probe),
    })
    if ok then _base_override = base end
    return ok and true or false
end

local function http_request(method, url, key, payload, timeout)
    if url:find(DEFAULT_BASE, 1, true) == 1 then
        if _base_override then
            url = _base_override .. url:sub(#DEFAULT_BASE + 1)
        elseif not probe_base(DEFAULT_BASE) and probe_base(LAN_BASE) then
            url = LAN_BASE .. url:sub(#DEFAULT_BASE + 1)
        end
    end
    http.TIMEOUT = timeout or 150
    local body = {}
    local headers = {
        ["x-diary-remote-key"] = key,
        ["accept"] = "application/json",
    }
    local source
    if payload then
        headers["content-type"] = "application/json"
        headers["content-length"] = #payload
        source = ltn12.source.string(payload)
    end
    local ok, code = http.request({
        url = url,
        method = method,
        headers = headers,
        source = source,
        sink = ltn12.sink.table(body),
    })
    if not ok then
        return nil, nil, tostring(code)
    end
    return table.concat(body), code, nil
end

-- ---- live page ------------------------------------------------------------
local function strip_html_noise(html)
    html = html:gsub("<script.-</script>", "")
    html = html:gsub("<style.-</style>", "")
    html = html:gsub("<head.->.-</head>", "")
    local body = html:match("<body.->(.*)</body>") or html
    return body
end

function NOTEBOOK:fetch_page()
    local cfg = self:cfg()
    local body, code = http_request("GET", cfg.base .. "/api/live-page/content", cfg.key, nil, 10)
    if body and code == 200 and body:match("<") then
        self._page_html = strip_html_noise(body)
        self._page_ok = true
    else
        self._page_ok = false
    end
end

-- ---- transcript -----------------------------------------------------------
function NOTEBOOK:render_messages(messages)
    local lines = {}
    for _, m in ipairs(messages or {}) do
        if m.role == "user" then
            local txt = (m.transcription and m.transcription ~= "") and m.transcription or (m.text or "")
            if txt == "" and m.ink and m.ink ~= "" then txt = "[ink]" end
            lines[#lines + 1] = "> " .. txt
        elseif m.role == "assistant" then
            lines[#lines + 1] = m.text or ""
        end
        lines[#lines + 1] = ""
    end
    return table.concat(lines, "\n")
end

-- ---- send -----------------------------------------------------------------
function NOTEBOOK:send_payload(payload)
    local cfg = self:cfg()
    if cfg.session_id ~= "" then
        payload.sessionId = cfg.session_id
    end
    local body, code, err = http_request("POST", cfg.base .. "/api/send", cfg.key, json.encode(payload))
    if not body then
        return nil, "network: " .. tostring(err)
    end
    local ok, data = pcall(json.decode, body)
    if not ok or not data then
        return nil, "bad response (" .. tostring(code) .. ")"
    end
    if not data.ok then
        return nil, data.error or ("http " .. tostring(code))
    end
    if data.sessionId then
        cfg.session_id = data.sessionId
        self:save_cfg()
    end
    return data
end

-- ---- reply card (liveReply in the web app) ---------------------------------
function NOTEBOOK:show_reply(data)
    local text = (data and data.text) or "?"
    local rv
    rv = TextViewer:new({
        title = _("Hermes"),
        text = text,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        buttons_table = {
            { { text = _("Close"), callback = function()
                UIManager:close(rv)
                if data.page and data.page ~= "" then
                    self._page_html = strip_html_noise(data.page)
                    self._page_ok = true
                else
                    self:fetch_page()
                end
                self:page_view()
            end } },
        },
    })
    UIManager:show(rv)
end

function NOTEBOOK:send_and_show(payload)
    local W, H = Screen:getWidth(), Screen:getHeight()
    local face = Font:getFace("cfont", 18)
    local busy = FrameContainer:new({
        width = W,
        height = H,
        borders = { top = 0, left = 0, right = 0, bottom = 0 },
        CenterContainer:new({
            dimen = Geom:new({ w = W, h = H }),
            TextWidget:new({ text = _("Sending to Hermes... this can take a minute."), face = face }),
        }),
    })
    UIManager:show(busy)
    UIManager:forceRePaint()

    local data, err = self:send_payload(payload)
    UIManager:close(busy)
    if not data then
        UIManager:show(InfoMessage:new({ text = T(_("Send failed:\n%1"), err or "?") }))
        self:page_view()
        return
    end
    -- ink was consumed by a successful send
    if payload.imageDataUrl then
        self._ink_png = nil
        os.remove(INK_PATH)
    end
    self:show_reply(data)
end

-- ---- main view: the page (livingSurface + liveBar) -------------------------
function NOTEBOOK:page_view()
    local cfg = self:cfg()
    local W, H = Screen:getWidth(), Screen:getHeight()
    self:fetch_page()

    local head_face = Font:getFace("ffont", 22)
    local small_face = Font:getFace("smallffont", 15)

    local status = _("Page: ") .. (self._page_ok and _("ready") or _("offline"))
    if self._ink_png then status = status .. "   |   " .. _("ink ready") end
    if cfg.session_id ~= "" then status = status .. "   |   " .. _("thread open") end

    -- surface: ink image wins over the page until sent (write-anywhere model)
    local surface
    if self._ink_png then
        surface = ImageWidget:new({
            file = self._ink_png,
            width = W,
            height = H - 130,
            image_disposable = false,
        })
    elseif self._page_html and self._page_ok then
        local ok_hb, hb = pcall(function()
            return HtmlBoxWidget:new({
                html = self._page_html,
                width = W,
                height = H - 130,
            })
        end)
        if ok_hb and hb then
            surface = hb
        else
            local plain = (self._page_html:gsub("<[^>]->", " "):gsub("%s+", " ")):sub(1, 4000)
            surface = TextViewer:new({ text = plain, width = W, height = H - 130, justified = false })
        end
    else
        surface = CenterContainer:new({
            dimen = Geom:new({ w = W, h = H - 130 }),
            TextWidget:new({
                text = _("Write anywhere, then tap Send.\nHermes builds the page under your ink."),
                face = head_face,
            }),
        })
    end

    local toolbar = ButtonTable:new({
        buttons = {
            {
                { text = _("New"), callback = function()
                    UIManager:close(self._view)
                    cfg.session_id = ""
                    self:save_cfg()
                    self._ink_png = nil
                    os.remove(INK_PATH)
                    self:page_view()
                end },
                { text = _("Pen"), callback = function()
                    UIManager:close(self._view)
                    self:pen_capture()
                end },
                { text = _("Send"), callback = function()
                    if not self._ink_png then
                        UIManager:show(InfoMessage:new({ text = _("Nothing to send — write something with the Pen first.") }))
                        return
                    end
                    local f = io.open(self._ink_png, "rb")
                    if not f then
                        self._ink_png = nil
                        self:page_view()
                        return
                    end
                    local data = f:read("*a")
                    f:close()
                    UIManager:close(self._view)
                    self:send_and_show({ imageDataUrl = "data:image/png;base64," .. b64(data) })
                end },
            },
            {
                { text = _("Redline"), callback = function()
                    if not self._ink_png then
                        UIManager:show(InfoMessage:new({ text = _("Mark something with the Pen first, then Redline.") }))
                        return
                    end
                    local f = io.open(self._ink_png, "rb")
                    if not f then
                        self._ink_png = nil
                        self:page_view()
                        return
                    end
                    local data = f:read("*a")
                    f:close()
                    UIManager:close(self._view)
                    self:send_and_show({ imageDataUrl = "data:image/png;base64," .. b64(data), intent = "redline" })
                end },
                { text = _("Type"), callback = function()
                    UIManager:close(self._view)
                    self:ask_text()
                end },
                { text = _("Pages"), callback = function()
                    UIManager:close(self._view)
                    self:pages_menu()
                end },
            },
        },
        width = W,
        borders = 0,
        separators = 0,
    })

    self._view = FrameContainer:new({
        width = W,
        height = H,
        borders = { top = 0, left = 0, right = 0, bottom = 0 },
        key_events = true,
        WidgetContainer:new({
            dimen = Geom:new({ x = 0, y = 0, w = W, h = H }),
            TextWidget:new({ text = _("Hermes"), face = head_face }),
            TextWidget:new({ text = status, face = small_face }),
            LineWidget:new({ width = W, dimen = Geom:new({ w = W, h = 2 }) }),
            surface,
            toolbar,
        }),
    })
    UIManager:show(self._view)
    UIManager:setDirty(self._view, "partial")
end

-- ---- pages menu (liveHistory) ----------------------------------------------
function NOTEBOOK:pages_menu()
    local cfg = self:cfg()
    local body = http_request("GET", cfg.base .. "/api/sessions", cfg.key, nil, 10)
    local sessions = {}
    if body then
        local ok, data = pcall(json.decode, body)
        if ok and data and data.sessions then sessions = data.sessions end
    end

    local menu
    local items = {}
    for _, s in ipairs(sessions) do
        items[#items + 1] = {
            text = s.title or s.id,
            post_text = tostring(s.count or 0) .. " msg",
            callback = function()
                UIManager:close(menu)
                self:show_session(s.id)
            end,
        }
    end
    if #items == 0 then
        items[1] = { text = _("No pages yet."), callback = function()
            UIManager:close(menu)
            self:page_view()
        end }
    end

    menu = Menu:new({
        title = _("Pages"),
        subtitle = cfg.base,
        item_table = items,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        single_line = false,
        ui = self.ui,
    })
    self._view = menu
    UIManager:show(menu)
end

-- ---- one session: transcript + reopen --------------------------------------
function NOTEBOOK:show_session(id)
    local cfg = self:cfg()
    local body = http_request("GET", cfg.base .. "/api/sessions/" .. id, cfg.key, nil, 10)
    local text = _("Could not load this session.")
    if body then
        local ok, data = pcall(json.decode, body)
        if ok and data and data.session then
            text = self:render_messages(data.session.messages)
        end
    end

    local tv
    tv = TextViewer:new({
        title = _("Page"),
        text = text,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        buttons_table = {
            {
                { text = _("Reopen thread"), callback = function()
                    UIManager:close(tv)
                    cfg.session_id = id
                    self:save_cfg()
                    self:page_view()
                end },
                { text = _("Reply (type)"), callback = function()
                    UIManager:close(tv)
                    cfg.session_id = id
                    self:save_cfg()
                    self:ask_text()
                end },
            },
            {
                { text = _("Back"), callback = function()
                    UIManager:close(tv)
                    self:pages_menu()
                end },
            },
        },
    })
    self._view = tv
    UIManager:show(tv)
end

-- ---- typed note ------------------------------------------------------------
function NOTEBOOK:ask_text()
    local W, H = Screen:getWidth(), Screen:getHeight()
    local input
    input = InputDialog:new({
        title = _("Note for Hermes"),
        input_hint = _("Type your note..."),
        width = W - 20,
        height = math.floor(H * 0.45),
        input_type = "text",
        text_type = "multiline",
        buttons = {
            {
                { text = _("Cancel"), callback = function()
                    UIManager:close(input)
                    self:page_view()
                end },
                { text = _("Send"), is_default = true, callback = function()
                    local text = input:getText()
                    UIManager:close(input)
                    if text and text:match("%S") then
                        self:send_and_show({ text = text })
                    else
                        self:page_view()
                    end
                end },
            },
        },
    })
    UIManager:show(input)
end

-- ---- pen capture -----------------------------------------------------------
function NOTEBOOK:pen_capture()
    local ok, err = pcall(function() self:pen_capture_inner() end)
    if not ok then
        if self._pen_restore then
            pcall(self._pen_restore)
            self._pen_restore = nil
        end
        if self._pen_overlay then
            UIManager:close(self._pen_overlay)
            self._pen_overlay = nil
        end
        UIManager:show(InfoMessage:new({ text = T(_("Pen mode hit a snag:\n%1"), tostring(err)) }))
        self:page_view()
    end
end

function NOTEBOOK:pen_capture_inner()
    local W, H = Screen:getWidth(), Screen:getHeight()
    local Blitbuffer = require("ffi/blitbuffer")
    local InputContainer = require("ui/widget/container/inputcontainer")

    local strokes = {}
    local current = nil
    local moved = 0
    local done = false
    local self_ref = self

    -- One custom widget: paints white page + all strokes straight to the bb.
    -- paintTo is overridden, so WidgetContainer never sets `dimen` itself;
    -- set it explicitly or UIManager cannot compute the refresh region.
    local overlay = InputContainer:new({
        dimen = Geom:new({ x = 0, y = 0, w = W, h = H }),
    })
    overlay.dimen = Geom:new({ x = 0, y = 0, w = W, h = H })
    function overlay:getSize() return Geom:new({ x = 0, y = 0, w = W, h = H }) end
    function overlay:paintTo(bb, x, y)
        bb:paintRect(x, y, W, H, Blitbuffer.COLOR_WHITE)
        for _, stroke in ipairs(strokes) do
            for i = 2, #stroke do
                local x1, y1 = stroke[i - 1].x, stroke[i - 1].y
                local x2, y2 = stroke[i].x, stroke[i].y
                local steps = math.max(1, math.floor(math.max(math.abs(x2 - x1), math.abs(y2 - y1))))
                for s = 0, steps do
                    local t = s / steps
                    bb:paintRect(x + math.floor(x1 + (x2 - x1) * t),
                                 y + math.floor(y1 + (y2 - y1) * t),
                                 3, 3, Blitbuffer.COLOR_BLACK)
                end
            end
        end
    end

    -- This build routes pen/eraser/highlighter MT slots to a stylus
    -- callback before gesture detection (Input:registerStylusCallback).
    -- Slots carry screen-scaled x/y; id == -1 means the pen lifted.
    local Input = require("device/input")
    local function restore_hook()
        pcall(Input.unregisterStylusCallback, Input)
    end
    self._pen_restore = restore_hook

    Input:registerStylusCallback(function(inp, slot)
        if done then return false end
        if slot.id == nil or slot.id == -1 then
            -- pen lifted: commit the stroke
            if current then
                if moved > 2 then
                    strokes[#strokes + 1] = current
                    UIManager:setDirty(overlay, "partial")
                else
                    -- tap with no drag = finish writing
                    current = nil
                    done = true
                    restore_hook()
                    self_ref:finish_pen(strokes)
                end
                current = nil
            end
            return true
        end
        local x, y = slot.x, slot.y
        if not x or not y then return true end
        if not current then
            current = { { x = x, y = y } }
            moved = 0
        else
            local last = current[#current]
            if math.abs(x - last.x) > 1 or math.abs(y - last.y) > 1 then
                current[#current + 1] = { x = x, y = y }
                moved = moved + 1
                UIManager:setDirty(overlay, "fast")
            end
        end
        return true -- dominate: no gestures while the pen is down
    end)

    self._pen_overlay = overlay
    UIManager:show(overlay)
    UIManager:setDirty(overlay, "full")
end

function NOTEBOOK:finish_pen(strokes)
    if self._pen_restore then
        pcall(self._pen_restore)
        self._pen_restore = nil
    end
    if self._pen_overlay then
        UIManager:close(self._pen_overlay)
        self._pen_overlay = nil
    end
    if not strokes or #strokes == 0 then
        self:page_view()
        return
    end
    -- Keep the ink on disk; Send ships it (write-anywhere model).
    pcall(function() os.execute("mkdir -p " .. INK_DIR) end)
    os.remove(INK_PATH)
    UIManager:forceRePaint()
    local ok_shot = pcall(function() Screen:shot(INK_PATH) end)
    if ok_shot then
        local f = io.open(INK_PATH, "rb")
        if f then
            f:close()
            self._ink_png = INK_PATH
        end
    end
    if not self._ink_png then
        UIManager:show(InfoMessage:new({ text = _("Could not capture the ink image.") }))
    end
    self:page_view()
end

-- ---- registration ----------------------------------------------------------
function NOTEBOOK:addToMainMenu(menu_items)
    menu_items.notebook = {
        text = _("Hermes Notebook"),
        sorting_hint = "tools",
        callback = function()
            self:onNotebookOpen()
        end,
        keep_menu_open = false,
    }
end

function NOTEBOOK:init()
    self.ui.menu:registerToMainMenu(self)
    local ok, Dispatcher = pcall(require, "dispatcher")
    if ok and Dispatcher then
        Dispatcher:registerAction("notebook_open", {
            category = "none",
            event = "NotebookOpen",
            title = _("Open Hermes Notebook"),
            general = true,
        })
    end
end

function NOTEBOOK:onNotebookOpen()
    local ok, err = pcall(function() self:page_view() end)
    if not ok then
        UIManager:show(require("ui/widget/textviewer"):new{
            title = _("Hermes Notebook error"),
            text = tostring(err),
        })
    end
    return true
end

function NOTEBOOK:exit()
    if self._view then UIManager:close(self._view) end
    if self._pen_overlay then UIManager:close(self._pen_overlay) end
end

return NOTEBOOK
