local WC = {}
WC.__index = WC
function WC.extend(o)
    o = o or {}
    setmetatable(o, { __index = WC })
    -- real KOReader classes are callable (Class{args}); mirror that without a
    -- self-referential __index on the subclass (a class table's __index must
    -- point at its PARENT, never at itself, or instance lookups loop).
    setmetatable(o, { __call = function(cls, args) return cls.new(cls, args) end })
    return o
end
function WC.new(cls, args) return setmetatable(args or {}, { __index = cls }) end
return WC
