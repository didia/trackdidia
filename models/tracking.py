#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb
import datetime
import utils
from custom_exceptions import SlotAlreadyUsed, BadArgumentError

class Schedule(ndb.Model):
    interval = ndb.FloatProperty(default = 0.5)
    starting_date = ndb.DateTimeProperty()
    ending_date = ndb.DateTimeProperty()
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
        
        for day in self._days:
            slot = Slot(parent=day.key, start_offset = 0, duration = number_of_sleep_interval, task = sleep_task.key)
            slots.append(slot)
        
        ndb.put_multi(slots)
    
    
    def get_all_days(self):
        if self._days is None:
            self._days = ndb.get_multi([ndb.Key(DayOfWeek, day_id, parent=self.key) for day_id in range(1,8)])
        
        return self._days
    
    def add_slot(self, task, day_id, start_offset, duration):
        higher_limit = 24/self.interval
        if(start_offset < 0 or start_offset >= higher_limit):
            message = "The start_offset parameter must be a number betwen "
            message += str(0) + " and "+ str(higher_limit) + ". " + str(start_offset) + " given"
            
            raise BadArgumentError(message)
        
        if(start_offset + duration > higher_limit):
            message = "The sum of the start_offset + duration must be less than "
            message = "the number of available slots, " + str(higher_limit)
            
            raise BadArgumentError(message)
        if(day_id < 1 or day_id > 8):
            raise BadArgumentError("Invalid value for day id. Must be between 1 and 8 ")
        
        day = self.get_day(day_id)
        day.add_slot(task, start_offset, duration)
            
    
    def add_slots(self):
        pass
    
    def remove_slot(self, day_id, slot_id):
        day = self.get_day(day_id)
        day.remove_slot(day_id)
        
         

class DayOfWeek(ndb.Model):
    interval_usage = ndb.BooleanProperty(repeated = True)
    _slots = None
    
    def add_slot(self, task, start_offset, duration):
        for i in range(start_offset, start_offset+duration):
            if(self.interval_usage[i]):
                message = "Asked to reserve Slot " + str(start_offset)
                if duration > 1:
                    message +=" to " +  str(start_offset+duration-1) + " inclusively"
                message += "\n But Slot " + str(i) + " is already reserved"
                
                raise SlotAlreadyUsed(message)
                
        slot = Slot(parent=self.key, task=task.key, start_offset = start_offset, duration = duration)
        slot.put()
        for i in range(start_offset, start_offset+duration):
            self.interval_usage[i] = True
        self.put()
        
        self.reload_slots()
        return slot
    
    def add_slots(self):
        pass
    
    def get_slot(self, slot_id):
        return Slot.get_by_id(slot_id,self.key)
    
    def get_slots(self):
        if self._slots is None:
            self.reload_slots()
        return self._slots
    
    def reload_slots(self):
        self._slots = Slot.query(ancestor=self.key).order(Slot.start_offset).fetch()
        if self._slots is None:
            self._slots = []
    
    def remove_slot(self, slot_id):
        slot = self.get_slot(slot_id)
        if slot is None:
            return
        
        for i in range(slot.start_offset, slot.start_offset + slot.duration):
            self.interval_usage[i] = False
        
        slot.key.delete()
        self.put()
        self.reload_slots()
        
            
    
    def to_dict(self):
        representation = dict()
        representation['interval_usage'] = self.interval_usage
        
        
    
    
    
class Slot(ndb.Model):
    start_offset = ndb.IntegerProperty(required=True)
    duration = ndb.IntegerProperty(required = True)
    task = ndb.KeyProperty(kind='Task')
    
    def get_start_offset(self):
        return self.start_offset
    
    def get_duration(self):
        return self.duration

