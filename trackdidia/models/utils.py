#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-30

@author: didia
'''
import datetime
from trackdidia import constants

today = datetime.date.today()

def get_week_start_and_end(date = None):
    '''
    Return a tuple consisting of the current week's monday datetime 
    and sunday datetime
    '''
    date = date or today
    weekday = date.weekday()
    monday = date - datetime.timedelta(days=weekday)
    saturday = date + datetime.timedelta(days=6-weekday)
    
    return monday, saturday

def get_today_id():
    
    date = today
    weekday = date.weekday()
    return weekday + 1 #because our id starts with 1

def get_week_id(date = None):
    date = date or today
    monday, saturday = get_week_start_and_end(date)

    week_id = monday.strftime(constants.WEEK_ID_FORMAT) + saturday.strftime(constants.WEEK_ID_FORMAT)
    return week_id

def get_last_week_id(date = None):
    
    date = (date or today)- datetime.timedelta(days = 7)
    
    return get_week_id(date)


    
        
        