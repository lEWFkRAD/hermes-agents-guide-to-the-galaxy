-- Minimal KOReader Class-like stub: cls.__index == cls, instances chain to cls.
local WC = {}
WC.__index = WC
WC.extend = function(_, o)
    o = o or {}
    setmetatable(o, { __index = WC })
    o.__index = o
    return o
end
WC.new = function(cls, args)
    return setmetatable(args or {}, { __index = cls })
end
return WC
