local D = {}
function D.open(cls, path) return setmetatable({ path = path, data = { last_percent_complete = 0.42 } }, { __index = cls }) end
function D:readSetting() return self.data end
return D
