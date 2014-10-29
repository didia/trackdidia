#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb
import datetime
import time




class Schedule(ndb.Model):
    interval = ndb.FloatProperty(default = 0.5)
    starting_date = ndb.DateTimeProperty()
    ending_date = ndb.DateTimeProperty()
    recurrent = ndb.BooleanProperty(default = True)
    days = [];
 
    def get_interval(self):
        return self.interval
    
    def get_interval_usage_array(self):
        return self.interval_usage
    
    def is_recurrent(self):
        return self.recurrent
    
    def initialize(self):
        self.set_starting_ending_date()
        self.initialize_days()
        
        pass
    
    def initialize_days(self):
        interval_usage = int(24/0.5)
        
        for i in range(7):
            day = DayOfWeek(id = i, parent=self.key, interval_usage = interval_usage)
            self.days[i] = day
        
        ndb.put_multi(self.days)
    
    def get_all_days(self):
        if self.days is None:
            self.days = ndb.get_multi([ndb.Key(DayOfWeek, day_id) for day_id in range(7)])
        
        return self.days
        
        
            
    def set_starting_ending_date(self, today=None):
        date = today or datetime.datetime.today()
        weekday = date.weekday()
        self.starting_date = date - datetime.timedelta(days=weekday)
        self.ending_date = date + datetime.timedelta(days=6-weekday)
    
    

class DayOfWeek(ndb.Model):
    interval_usage = ndb.BooleanProperty(repeated = True)
    
    def get_interval_usage_array(self):
        return self.interval_usage
    
class Slot(ndb.Model):
    start_offset = ndb.IntegerProperty(required=True)
    duration = ndb.IntegerProperty(required = True)
    task = ndb.KeyProperty(kind='Task')
    
    def get_start_offset(self):
        return self.start_offset
    
    def get_duration(self):
        return self.duration
    