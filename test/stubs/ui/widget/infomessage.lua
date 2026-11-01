local Info = {}
function Info.new(cls, args) table.insert((require("ui/uimanager")).log, {"info", args and args.text}); return setmetatable(args or {}, { __index = cls }) end
Info.__index = Info
return Info
