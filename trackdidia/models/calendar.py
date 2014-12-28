#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-28

@author: didia
'''
from google.appengine.ext import ndb
from . import utils
from .custom_exceptions import SchedulingConflict
from .custom_exceptions import BadArgumentError
from trackdidia.models.scheduled_task import ScheduledTask
from trackdidia import constants

    
class Day(ndb.Model):
    interval_usage = ndb.BooleanProperty(repeated = True)
    _scheduled_tasks = None
    
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
        
    def add_scheduled_task(self, task, offset, duration):
        self.validate_offset_and_duration(offset, duration)
        
                
        scheduled_task = ScheduledTask(parent=self.key, task=task.key, offset= offset, duration = duration)
        scheduled_task.put()
        for i in range(offset, offset+duration):
            self.interval_usage[i] = True
        self.put()
        
        if not self._scheduled_tasks is None:
            self._scheduled_tasks.append(scheduled_task)
        return scheduled_task
    
    def clone_scheduled_task(self, scheduled_task):
        self.validate_offset_and_duration(scheduled_task.offset, scheduled_task.duration)
        
        new_key = ndb.Key(flat=[ScheduledTask, scheduled_task.key.id()], parent = self.key)
        scheduled_task.key = new_key
        scheduled_task.put()
    def get_scheduled_task(self, scheduled_task_id):
        return ScheduledTask.get_by_id(scheduled_task_id,parent = self.key)
    
    def get_scheduled_tasks(self):
        if self._scheduled_tasks is None:
            self.reload_scheduled_tasks()
        return self._scheduled_tasks
    
    def reload_scheduled_tasks(self):
        self._scheduled_tasks = ScheduledTask.query(ancestor=self.key).order(ScheduledTask.offset).fetch()
        if self._scheduled_tasks is None:
            self._scheduled_tasks = []
    
    def remove_scheduled_task(self, scheduled_task_id):
        scheduled_task = self.get_scheduled_task(scheduled_task_id)
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
            

    def set_executed(self, scheduled_task_id, executed=True):
 
        if(type(scheduled_task_id)) is dict:
            scheduled_tasks = []
            for key, value in scheduled_task_id.iteritems():
                scheduled_task = self.get_scheduled_task(key)
                scheduled_task.executed = value
                scheduled_tasks.append(scheduled_task)
            ndb.put_multi(scheduled_tasks)
            return scheduled_tasks
                 
        else:
            scheduled_task = self.get_scheduled_task(scheduled_task_id)
            scheduled_task.executed = executed
            scheduled_task.put()
            return scheduled_task
    
    def restart(self):
        scheduled_tasks = self.get_scheduled_tasks()
        for scheduled_task in scheduled_tasks :
            scheduled_task.executed = False
        ndb.put_multi(scheduled_tasks)
        
    def get_executed_slots(self):
        return ScheduledTask.query(ancestor=self.key).filter(ScheduledTask.executed == True).fetch()

 
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
        days = self.get_all_days()
        self.get_owner()
        sleep_task = self._owner.create_task(name='Sleep')
        scheduled_tasks = []
        number_of_sleep_interval = int(6/self.interval)
        
        for day in days:
            for i in range(number_of_sleep_interval):
                day.interval_usage[i] = True
            scheduled_task = ScheduledTask(parent=day.key, offset = 0, duration = number_of_sleep_interval, task = sleep_task.key)
            scheduled_tasks.append(scheduled_task)
        
        ndb.put_multi(scheduled_tasks)
        ndb.put_multi(days)   
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
    
    
    def add_recurrence(self, scheduled_task, recurrence_type):
        if not self.recurrent:
            raise BadArgumentError("The week " + self.key.id() + " is not a recurrent week")
        
        if recurrence_type == constants.RECURRENCE_TYPES[1]: #daily
            day_id = scheduled_task.key.parent().id()
            scheduled_task_week = scheduled_task.key.parent().parent().get()
            for i in range(day_id + 1, 8):
                scheduled_task_week.get_day(i).clone_scheduled_task(scheduled_task)
            for i in range(1, 8):
                self.get_day(i).clone_scheduled_task(scheduled_task)
        if recurrence_type == constants.RECURRENCE_TYPES[2] : #weekly
            self.get_day(scheduled_task.key.parent().id()).clone_scheduled_task(scheduled_task)
