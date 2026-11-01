local R = {}
R.opened = nil
function R:showReader(p) self.opened = p; return true end
return R
