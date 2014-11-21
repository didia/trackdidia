#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-01

@author: didia
'''

import webapp2
import os
from router import applications_routes
import jinja2

__all__ = ['debug', 'config', 'jinja_environment']

if os.environ['SERVER_SOFTWARE'].find('Development') == 0:
    debug = True
else:
    debug = False

jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader(os.path.dirname(__file__)))









config = {
  'webapp2_extras.auth': {
    'user_model': 'models.user.User',
    'user_attributes': ['nickname'],
    #'session_backend': 'datastore'
    'session_backend': 'memcache'
  },
  'webapp2_extras.sessions': {
    'secret_key': "YOUR APP SECRET",
    'backends':{'datastore': 'webapp2_extras.appengine.sessions_ndb.DatastoreSessionFactory',
                 'memcache': 'webapp2_extras.appengine.sessions_memcache.MemcacheSessionFactory',
                 'securecookie': 'webapp2_extras.sessions.SecureCookieSessionFactory' 
}
  }
}




app = webapp2.WSGIApplication(routes=applications_routes,
                               config=config,
                              debug=debug)
