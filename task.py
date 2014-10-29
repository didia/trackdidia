#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-25

@author: didia
'''

from google.appengine.ext import ndb

def create_task(owner, name, **kargs):
    task = Task(parent = owner.key, name=name, **kargs)
    task.put()
    return task.to_dict()

def get_task(owner, task_id):
    task = Task.get_by_id(task_id, parent = owner.key)
    if(not task is None):
        return task.to_dict()
    return None

def edit_task(owner, task_id, **kargs):
    task = Task.get_by_id(task_id, parent = owner.key);
    if(not task is None):
        task.populate(**kargs)
        task.put()
    return task.to_dict()

def delete_task(owner, task_id):
    key = ndb.Key(Task, task_id, parent = owner.key)
    key.delete()
    
    

    
class Task(ndb.Model):
    category = ndb.StringProperty()
    name = ndb.StringProperty(required = True)
    description = ndb.TextProperty()
    location = ndb.StringProperty()
    priority = ndb.IntegerProperty(choices=[0,1,2,3,4,5], default=1)
        
    def to_dict(self):
        """
        Function to get the task as a dict
        return a dict that contains info about the ticket
        """
        a_dict = super(Task, self).to_dict()
        a_dict["id"] = self.key.integer_id()
            
        
        return a_dict
     
     
    def get_id(self):
        return self.key.id()
    def set_name(self, p_name):
        self.name = p_name
        
    def set_description(self, p_description):
        self.description = p_description
    
    def set_location(self, p_location):
        self.location = p_location
    
    def set_priority(self, p_priority):
        self.priority = p_priority



