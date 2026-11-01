local Screen = {
  _w = 1404, _h = 1872,
  getWidth = function(self) return self._w end,
  getHeight = function(self) return self._h end,
  scaleBySize = function(self, n) return n end,
}
local Device = {
  screen = Screen,
  batteryInfo = function() return { percentage = 87 } end,
}
return Device
