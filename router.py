#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-01

@author: didia
'''

import webapp2
from webapp2_extras import routes

import controllers.handlers as handlers


__all__ = ['applications_routes']

applications_routes = [ webapp2.Route('/', handlers.MainHandler, name='main'),
                       routes.PathPrefixRoute('/api', [
                        routes.PathPrefixRoute('/task', [
                            webapp2.Route('/create', handler=handlers.TaskHandler, handler_method='create', name='task_create', methods=['POST']),
                            webapp2.Route('/list', handler=handlers.TaskHandler, handler_method='list_all', name='task_list_all'),
                            routes.PathPrefixRoute('/<task_id:[\d]+>', [
                                webapp2.Route('/update', handler=handlers.TaskHandler, handler_method='update', name='task_update', methods=['POST']),
                                webapp2.Route('/create', handler=handlers.TaskHandler, handler_method='delete', name='task_delete', methods=['POST']),
                                webapp2.Route('', handler=handlers.TaskHandler, handler_method='get', name='task_get'),
                            ])
                            
                        ])
                       ])
                      ]

