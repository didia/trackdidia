'''
Created on 2014-11-20

@author: didia
'''
from google.appengine.ext import ndb


class Slot(ndb.Model):
    offset = ndb.IntegerProperty(required=True)
    duration = ndb.IntegerProperty(required = True)
    task = ndb.KeyProperty(kind='Task', required = True)
    executed = ndb.BooleanProperty(default = False)
    
    def get_offset(self):
        return self.offset
    
    def get_duration(self):
        return self.duration
    
    def get_task(self):
        return self.task.get()
