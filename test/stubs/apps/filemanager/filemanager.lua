local FM = {}
FM.instance = { file_chooser = { changed_to = nil,
    changeToPath = function(self, p) self.changed_to = p end } }
return FM
