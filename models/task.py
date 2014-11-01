#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-25

@author: didia
'''

from google.appengine.ext import ndb
    
class Task(ndb.Model):
    category = ndb.StringProperty(default = 'All')
    name = ndb.StringProperty(required = True)
    description = ndb.TextProperty()
    location = ndb.StringProperty()
    priority = ndb.IntegerProperty(choices=[0,1,2,3,4,5], default=1)
    _owner = None
        
    def get_representation(self):
        """
        Function to get the task as a dict
        return a dict that contains info about the ticket
        """
        a_dict = self.to_dict(include=['name', 'category', 'description', 'location', 'priority'])
        a_dict["id"] = self.key.integer_id()
            
        
        return a_dict
    
    def update(self, **kwargs):
        if not kwargs is None:
            self.populate(**kwargs)
            self.put()
        return self
    
    def get_owner(self):
        if self._owner is None:
            self._owner = self.key.parent().get()
        return self._owner
     



