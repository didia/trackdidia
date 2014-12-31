'''
Created on 2014-11-20

@author: didia
'''
from google.appengine.ext import ndb
from trackdidia import constants
from trackdidia.utils import utils

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
    
    def __eq__(self, other):
        if self.recurrence != "None" and other.recurrence != "None":
            return self.recurrence == other.recurrence and self.key.id() == other.key.id()
        return super(ScheduledTask, self).__eq__(other)
    
    @classmethod
    def find(cls, ancestor, unique = False, active_only = False, task_key = None):
        all_scheduled_tasks = cls.query(ancestor=ancestor)
        if task_key:
            all_scheduled_tasks = all_scheduled_tasks.filter(cls.task == task_key)
        all_scheduled_tasks = all_scheduled_tasks.order(cls.offset).fetch()
        
        if unique:
            seen = {}
            result = []
            for item in all_scheduled_tasks:
                marker = "{}{}".format(item.recurrence, item.offset)
                if item.recurrence == "None":
                    result.append(item)
                    continue
                if marker in seen: continue
                seen[marker] = 1
                result.append(item)
            all_scheduled_tasks = result
        
        if active_only:
            result = []
            for item in all_scheduled_tasks:
                today = utils.get_today_id()
                if item.recurrence == "None" and item.key.parent().id() < today: continue
            
                result.append(item)
            all_scheduled_tasks = result
        return all_scheduled_tasks
 
        

