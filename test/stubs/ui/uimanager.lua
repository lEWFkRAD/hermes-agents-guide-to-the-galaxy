local M = { log = {} }
function M:show(w) table.insert(self.log, {"show", w}); return true end
function M:close(w) table.insert(self.log, {"close", w}); return true end
function M:nextTick(f) f(); return true end
function M:setDirty() end
return M
