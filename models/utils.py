#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-30

@author: didia
'''
import datetime

def get_week_start_and_end(today = None):
    '''
    Return a tuple consisting of the current week's monday datetime 
    and sunday datetime
    '''
    date = today or datetime.date.today()
    weekday = date.weekday()
    monday = date - datetime.timedelta(days=weekday)
    saturday = date + datetime.timedelta(days=6-weekday)
    
    return monday, saturday

def get_today_id(today = None):
    
    date = today or datetime.datetime.today()
    weekday = date.weekday()
    return weekday + 1 #because our id starts with 1