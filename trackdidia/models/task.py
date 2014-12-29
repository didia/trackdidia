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
    deleted = ndb.BooleanProperty(default = False)
    _owner = None
        
    def update(self, **kwargs):
        if not kwargs is None:
            self.populate(**kwargs)
            self.put()
        return self
    
    def get_owner(self):
        if self._owner is None:
            self._owner = self.key.parent().get()
        return self._owner
    

        
     



