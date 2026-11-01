return setmetatable({}, { __call = function(_, s) return s end })
