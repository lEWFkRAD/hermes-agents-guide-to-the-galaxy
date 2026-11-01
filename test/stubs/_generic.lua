-- KOReader Class-style stub: instances get a metatable with __index=class and
-- __newindex that stores into the instance (no key collision between the two
-- metamethods, unlike a shared __table).
local W = {}
W.__index = W
function W.extend(o) o = o or {}; setmetatable(o, { __index = W }); return o end
function W.new(cls, args)
    local inst = {}
    for k, v in pairs(args or {}) do inst[k] = v end
    return setmetatable(inst, { __index = cls })
end
setmetatable(W, { __call = function(cls, args) return cls.new(cls, args) end })
return W
