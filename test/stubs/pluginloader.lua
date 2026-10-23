local P = {}
P.instances = {}
function P:loadPlugins() return true end
function P:getPluginInstance(name) return self.instances[name] end
return P
