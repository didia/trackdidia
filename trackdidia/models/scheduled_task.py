'''
Created on 2014-11-20

@author: didia
'''
from google.appengine.ext import ndb
from trackdidia import constants

class ScheduledTask(ndb.Model):
    offset = ndb.IntegerProperty(required=True)
    duration = ndb.IntegerProperty(required = True)
    task = ndb.KeyProperty(kind='Task', required = True)
    executed = ndb.BooleanProperty(default = False)
    recurrence = ndb.StringProperty(default="None", choices=constants.RECURRENCE_TYPES)
    
    def set_executed(self, executed):
        self.executed = executed
        self.put()
        return self
