'''
Created on 2014-11-20

@author: didia
'''

from google.appengine.ext import ndb
from . import utils
from .custom_exceptions import BadArgumentError, SlotNotYetReached

from day import DayOfWeek

class Schedule(ndb.Model):
    interval = ndb.FloatProperty(default = 0.5)
    starting_date = ndb.DateProperty()
    ending_date = ndb.DateProperty()
    recurrent = ndb.BooleanProperty(default = True)
    _days = None
    _owner = None
 
    def get_interval(self):
        return self.interval
    
    def get_day(self, day_id):
        return ndb.Key(DayOfWeek, day_id, parent=self.key).get()
    
    def get_interval_usage_array(self):
        return self.interval_usage
    
    def is_recurrent(self):
        return self.recurrent
    
    def get_owner(self):
        if self._owner is None:
            self._owner = self.key.parent().get()
        return self._owner
    
    def initialize(self):
        
        self.starting_date, self.ending_date = utils.get_week_start_and_end()
        interval_usage = [False for i in range(int(24/self.interval))]
        number_of_sleep_interval = int(6/self.interval)
        for i in range(number_of_sleep_interval):
            interval_usage[i] = True
        slots = []
        self._days = []
        for i in range(1,8):
            day = DayOfWeek(id = i, parent=self.key, interval_usage = interval_usage)
            self._days.append(day)
                   
        ndb.put_multi(self._days)
        self.get_owner()
        sleep_task = self._owner.create_task(name='Sleep')
        
        from slot import Slot
        
        for day in self._days:
            slot = Slot(parent=day.key, offset = 0, duration = number_of_sleep_interval, task = sleep_task.key)
            slots.append(slot)
        
        ndb.put_multi(slots)
    
    
    def get_all_days(self):
        if self._days is None:
            self._days = ndb.get_multi([ndb.Key(DayOfWeek, day_id, parent=self.key) for day_id in range(1,8)])
        
        return self._days
    
    
    def set_executed(self, day_id, slot_id, executed=True):
        today_id = utils.get_today_id()
        
        if day_id > today_id:
            message = "Day id  " + str(day_id) + " must be "
            message += " inferior to today's id " + str(today_id)
            raise SlotNotYetReached(message) 
        
        day = self.get_day(day_id)
        return day.set_executed(slot_id, executed)
        
    
    def restart(self):
        self.starting_date, self.ending_date = utils.get_week_start_and_end()
        days = self.get_all_days()
        self.put_async()
        for day in days:
            day.restart()

        