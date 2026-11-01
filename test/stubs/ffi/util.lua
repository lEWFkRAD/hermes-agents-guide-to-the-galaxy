-- KOReader-style template: replaces %1, %2, ... with positional args.
local function template(fmt, ...)
    local args = { ... }
    return (fmt:gsub("%%(%d)", function(n) return tostring(args[tonumber(n)]) end))
end
return { template = template }
