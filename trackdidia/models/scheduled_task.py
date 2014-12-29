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
    timespent = ndb.IntegerProperty(default = 0)
    recurrence = ndb.StringProperty(default="None", choices=constants.RECURRENCE_TYPES)
    unexepected = ndb.BooleanProperty(default = False)
    priority = ndb.IntegerProperty(choices=[0,1,2,3,4,5], default=1)
    
    def set_executed(self, executed, timespent = None):
        timespent = timespent or self.duration
        self.executed = executed
        self.timespent = timespent
        self.put()
        return self
    
    def get_point(self):
        if not self.executed:
            return (0, self.duration)
        return (self.timespent*self.priority, self.duration*self.priority)
    
    def find(self, week_key = None, day_key = None):
        pass

