#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb
import datetime
import utils
from custom_exceptions import SlotAlreadyUsed, BadArgumentError, SlotNotYetReached
from collections import OrderedDict

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
    
    def set_executed(self, day_id, slot_id, executed=True):
        today_id = utils.get_today_id()
        if day_id > today_id:
            message = "Day id must be before " + str(today_id) + " must be "
            message += " inferior to today's id " + str(day_id)
            raise SlotNotYetReached(message) 
        
        day = self.get_day(day_id)
        day.set_executed(self, slot_id, executed)
    
    def restart(self):
        days = self.get_all_days()
        for day in days:
            day.restart()
    
    def get_representation(self):
        representation = OrderedDict()
        representation['schedule_id'] = self.key.id()
        representation['interval'] = self.interval
        representation['starting_date'] = self.starting_date.strftime("%d/%m/%Y")
        representation['ending_date'] = self.ending_date.strftime("%d/%m/%Y")
        days = [day.get_representation() for day in self.get_all_days()]
        
        representation['days'] = days
        
        return representation
        
        
        
         

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
    
    def set_executed(self, slot_id, executed=True):

        if(type(slot_id)) is dict:
            slots = []
            for key, value in slot_id.iteritems():
                slot = self.get_slot(key)
                slot.executed = value
                slots.append(slot)
            ndb.put_multi(slots)
                
        else:
            slot = self.get_slot(slot_id)
            slot.executed = executed
            slot.put()
    
    def restart(self):
        slots = self.get_slots()
        for slot in slots :
            slot.executed = False
        ndb.put_multi(slots)
    
    def get_representation(self):
        representation = OrderedDict()
        representation['day_id'] = self.key.integer_id()
        representation['interval_usage'] = self.interval_usage
        slots = [slot.get_representation() for slot in self.get_slots()]
        representation['slots'] = slots
        
        return representation
    
        
    
    
    
class Slot(ndb.Model):
    start_offset = ndb.IntegerProperty(required=True)
    duration = ndb.IntegerProperty(required = True)
    task = ndb.KeyProperty(kind='Task')
    executed = ndb.BooleanProperty(default = False)
    
    def get_start_offset(self):
        return self.start_offset
    
    def get_duration(self):
        return self.duration
    
    def get_representation(self):
        representation = OrderedDict()
        representation['slot_id'] = self.key.integer_id()
        representation['start_offset'] = self.start_offset
        representation['duration'] = self.duration
        representation['executed'] = self.executed
        task = self.task.get()
        
        representation['task_id'] = task.key.integer_id()
        representation['task_name'] = task.name
        representation['task_description'] = task.description
        representation['category'] = task.category
        representation['location'] = task.location
        representation['priority'] = task.priority
        
        return representation
    

