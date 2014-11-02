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

task_route = routes.PathPrefixRoute('/tasks', [
                 webapp2.Route('/create', handler=handlers.TaskHandler, handler_method='create', name='task_create', methods=['POST']),
                 webapp2.Route('/list', handler=handlers.TaskHandler, handler_method='list', name='task_list_all'),
                 routes.PathPrefixRoute('/<task_id:[\d]+>', [
                     webapp2.Route('/update', handler=handlers.TaskHandler, handler_method='update', name='task_update', methods=['POST']),
                     webapp2.Route('/delete', handler=handlers.TaskHandler, handler_method='delete', name='task_delete', methods=['POST']),
                     webapp2.Route('', handler=handlers.TaskHandler, handler_method='get', name='task_get'),
                  ]),
                 webapp2.Route('', handler=handlers.TaskHandler, handler_method='list', name='task_list_all'),
                            
             ])
slot_route = routes.PathPrefixRoute('/slots', [
                 webapp2.Route('/create', handler = handlers.SlotHandler, handler_method = 'create'),
                 webapp2.Route('/list', handler=handlers.SlotHandler, handler_method = 'list'),                                           
                 routes.PathPrefixRoute('/<slot_id:[\d]+>', [
                     webapp2.Route('/update', handler = handlers.SlotHandler, handler_method = 'update', methods=['POST']),
                     webapp2.Route('/delete', handler = handlers.SlotHandler, handler_method = 'delete', methods=['POST']),
                     webapp2.Route('/executed/<executed:[0-1]>', handler=handlers.SlotHandler, handler_method='set_executed', methods=['POST']),
                     webapp2.Route('', handler = handlers.SlotHandler, handler_method = 'get')
                 ]),
                 webapp2.Route('', handler=handlers.SlotHandler, handler_method = 'list')
                                            
             ])

day_route = routes.PathPrefixRoute('/days', [
                webapp2.Route('/list', handler=handlers.DayHandler, handler_method = 'list'),
                routes.PathPrefixRoute('/<day_id:[1-7]>', [ 
                    slot_route,
                    webapp2.Route('', handler=handlers.DayHandler, handler_method= 'get')
                ]),
                webapp2.Route('', handler=handlers.DayHandler, handler_method='list')
                                
            ])
                                
schedule_route = routes.PathPrefixRoute('/schedules', [                                  
                     routes.PathPrefixRoute('/<schedule_id:[\w]+>', [
                         day_route,
                         webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get')
                     ]),
                     webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get')
                 ])

applications_routes = [ webapp2.Route('/', handlers.MainHandler, name='main'),
                        routes.PathPrefixRoute('/api', [
                            task_route,
                            schedule_route
                        ])
                      ]

