#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-25

@author: didia
'''

from google.appengine.ext import ndb
    
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
    
    def update(self, **kwargs):
        if not kwargs is None:
            self.populate(**kwargs)
            self.put()
        return self
     



