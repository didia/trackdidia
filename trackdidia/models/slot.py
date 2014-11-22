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
    
    def set_executed(self, executed):
        self.executed = executed
        self.put()
