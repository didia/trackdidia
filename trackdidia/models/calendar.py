#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-28

@author: didia
'''
from google.appengine.ext import ndb
from trackdidia.utils import utils
from .custom_exceptions import SchedulingConflict
from .custom_exceptions import BadArgumentError
from trackdidia.models.scheduled_task import ScheduledTask
from trackdidia import constants

def invalidate_cache(function):
    def call_invalidate_cache(self, *args, **kwargs):
        self.invalidate_cache()
        return function(self, *args, **kwargs)
    
    return call_invalidate_cache
    
        
    
    
class Day(ndb.Model):
    interval_usage = ndb.BooleanProperty(repeated = True)
    _scheduled_tasks = None
    _stat = None
    
    def validate_offset_and_duration(self, offset, duration):
        higher_limit = len(self.interval_usage)
        if(offset < 0 or offset >= higher_limit):
            message = "The offset parameter must be a number betwen "
            message += str(0) + " and "+ str(higher_limit) + ". " + str(offset) + " given"
            
            raise BadArgumentError(message)
        
        if(offset + duration > higher_limit):
            message = "The sum of the offset + duration must be less than "
            message = "the number of available slots, " + str(higher_limit)
            
            raise BadArgumentError(message)
        
        for i in range(offset, offset+duration):
            if(self.interval_usage[i]):
                message = "Asked to reserve Slot " + str(offset)
                if duration > 1:
                    message +=" to " +  str(offset+duration-1) + " inclusively"
                message += "\n But Slot " + str(i) + " is already reserved"
                
                raise SchedulingConflict(message)
            
    @invalidate_cache
    def add_scheduled_task(self, task, offset, duration, recurrence = None):
        self.validate_offset_and_duration(offset, duration)
        
        self.invalidate_cache()
        if not recurrence:
            recurrence = constants.RECURRENCE_TYPES[0]
        scheduled_task = ScheduledTask(parent=self.key, task=task.key, offset= offset, duration = duration, recurrence = recurrence)
        
        for i in range(offset, offset+duration):
            self.interval_usage[i] = True
        
        ndb.put_multi([scheduled_task, self])
        if not self._scheduled_tasks is None:
            self._scheduled_tasks.append(scheduled_task)
        return scheduled_task
    
    @invalidate_cache
    def clone_scheduled_task(self, scheduled_task):
        self.validate_offset_and_duration(scheduled_task.offset, scheduled_task.duration)
        if scheduled_task.key:
            new_key = ndb.Key(flat=[ScheduledTask, scheduled_task.key.id()], parent = self.key)
            scheduled_task.key = new_key
        else:
            scheduled_task = ScheduledTask(parent=self.key, task=scheduled_task.task, offset= scheduled_task.offset, duration = scheduled_task.duration, recurrence = scheduled_task.recurrence)
            
        for i in range(scheduled_task.offset, scheduled_task.offset+scheduled_task.duration):
            self.interval_usage[i] = True
        
        ndb.put_multi([self, scheduled_task])
    def get_stat(self):
        if not self._stat:
            scheduled_tasks = self.get_scheduled_tasks()
            interval = 24.0/len(self.interval_usage)
            self._stat = reduce(lambda x, y:(x[0] + y[0], x[1] + y[1]), map(lambda z: z.get_point(), scheduled_tasks))
            self._stat = (self._stat[0]*interval, self._stat[1]*interval)
        return self._stat
        
    
    def get_scheduled_task(self, scheduled_task_id):
        return ScheduledTask.get_by_id(scheduled_task_id,parent = self.key)
    
    def get_scheduled_tasks(self):
        if not self._scheduled_tasks:
            self.reload_scheduled_tasks()
        return self._scheduled_tasks
    
    @invalidate_cache
    def reload_scheduled_tasks(self):
        self._scheduled_tasks = ScheduledTask.query(ancestor=self.key).order(ScheduledTask.offset).fetch()
        if not self._scheduled_tasks:
            self._scheduled_tasks = []
            
    @invalidate_cache
    def remove_scheduled_task(self, scheduled_task_id = None, scheduled_task = None):
        scheduled_task = scheduled_task or self.get_scheduled_task(scheduled_task_id)
        if not scheduled_task is None:
            for i in range(scheduled_task.offset, scheduled_task.offset + scheduled_task.duration):
                self.interval_usage[i] = False
            
            if not self._scheduled_tasks is None:
                try:
                    self._scheduled_tasks.remove(scheduled_task)
                except ValueError:
                    pass
            scheduled_task.key.delete()
            self.put()
        self.invalidate_cache()
            
    @invalidate_cache
    def set_executed(self, scheduled_task_id, executed=True, timespent = None):

        if(type(scheduled_task_id)) is dict:
            scheduled_tasks = []
            for key, value in scheduled_task_id.iteritems():
                scheduled_task = self.get_scheduled_task(key)
                scheduled_task.timespent = scheduled_task.duration;
                scheduled_task.executed = value
                scheduled_tasks.append(scheduled_task)
            ndb.put_multi(scheduled_tasks)
            return scheduled_tasks
                 
        else:
            scheduled_task = self.get_scheduled_task(scheduled_task_id)
            timespent = timespent or scheduled_task.duration
            scheduled_task.executed = executed
            scheduled_task.timespent = timespent
            scheduled_task.put()
            return scheduled_task
        
    @invalidate_cache
    def restart(self):
        scheduled_tasks = self.get_scheduled_tasks()
        for scheduled_task in scheduled_tasks :
            scheduled_task.executed = False
        ndb.put_multi(scheduled_tasks)
        
    def get_executed_slots(self):
        return ScheduledTask.query(ancestor=self.key).filter(ScheduledTask.executed == True).fetch()
    
    def invalidate_cache(self):
        self._scheduled_tasks = None
        self._stat = None

 
class Week(ndb.Model):
    interval = ndb.FloatProperty(default = 0.5)
    starting_date = ndb.DateProperty()
    ending_date = ndb.DateProperty()
    recurrent = ndb.BooleanProperty(default = False)
    _days = None
    _owner = None
    
 
    
    def get_day(self, day_id):
        return ndb.Key(Day, day_id, parent=self.key).get()
    
    def get_owner(self):
        if self._owner is None:
            self._owner = self.key.parent().get()
        return self._owner
    
    def initialize(self):
        self.starting_date, self.ending_date = utils.get_week_start_and_end()
        interval_usage = [False for i in range(int(24/self.interval))]

        self._days = []
        for i in range(1,8):
            day = Day(id = i, parent=self.key, interval_usage = interval_usage)
            self._days.append(day)
                   
        ndb.put_multi(self._days)
    
    def add_default_sleep_task(self):
        self.get_owner()
        sleep_task = self._owner.create_task(name='Sleep')
        number_of_sleep_interval = int(6/self.interval)
        scheduled_task = ScheduledTask(offset = 0, duration = number_of_sleep_interval, task = sleep_task.key, recurrence="daily")
        self.add_recurrence(scheduled_task)
       
    def get_all_days(self):
        if self._days is None:
            self._days = ndb.get_multi([ndb.Key(Day, day_id, parent=self.key) for day_id in range(1,8)])
        return self._days 
    
    def restart(self):
        self.starting_date, self.ending_date = utils.get_week_start_and_end()
        days = self.get_all_days()
        self.put_async()
        for day in days:
            day.restart()
    
    def add_scheduled_task(self, day_id, task, offset, duration, recurrence = False):
        day = self.get_day(day_id)
        scheduled_task = day.add_scheduled_task(task, offset = offset, duration = duration, recurrence = recurrence)
        if recurrence:
            weekly = self.get_owner().get_week('weekly')
            weekly.add_recurrence(scheduled_task)
           
            if scheduled_task.recurrence == constants.RECURRENCE_TYPES[1]:     
                for i in range(day_id + 1, 8):
                    self.get_day(i).clone_scheduled_task(scheduled_task)  
                
        
        return scheduled_task
    
    def delete_scheduled_task(self, day_id, scheduled_task, recurrence = False):
        self.get_day(day_id).remove_scheduled_task(scheduled_task.key.id())
        if recurrence:
            weekly = self.get_owner().get_week("weekly")
            weekly.delete_recurrence(scheduled_task)
            if scheduled_task.recurrence == constants.RECURRENCE_TYPES[1]:
                for i in range(day_id+1, 8):
                    self.get_day(i).remove_scheduled_task(scheduled_task.key.id())               
    
    def add_recurrence(self, scheduled_task):
        if not self.recurrent:
            raise BadArgumentError("The week " + self.key.id() + " is not a recurrent week")
        
        if scheduled_task.recurrence == constants.RECURRENCE_TYPES[1]: #daily    
            for i in range(1, 8):
                self.get_day(i).clone_scheduled_task(scheduled_task)
        elif scheduled_task.recurrence == constants.RECURRENCE_TYPES[2] : #weekly
            self.get_day(scheduled_task.key.parent().id()).clone_scheduled_task(scheduled_task)
    
    def delete_recurrence(self, scheduled_task):
        if not self.recurrent:
            raise BadArgumentError("The week " + self.key.id() + "is not a recurrent week")
        
        if scheduled_task.recurrence == constants.RECURRENCE_TYPES[1]:
            for day in self.get_all_days():
                day.remove_scheduled_task(scheduled_task_id = scheduled_task.key.id())
        elif scheduled_task.recurrence == constants.RECURRENCE_TYPES[2]:
            self.get_day(scheduled_task.key.parent().id()).remove_scheduled_task(scheduled_task_id = scheduled_task.key.id())
    
    def get_stat(self):
        return reduce(lambda x, y:(x[0] + y[0], x[1] + y[1]), map(lambda z: z.get_stat(), self.get_all_days()))
    
        

