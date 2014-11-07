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
                 webapp2.Route('/create', handler=handlers.TaskHandler, handler_method='create', name = 'create_task', methods=['POST']),
                 webapp2.Route('/list', handler=handlers.TaskHandler, handler_method='list', name = 'all_tasks'),
                 routes.PathPrefixRoute('/<task_id:[\d]+>', [
                     webapp2.Route('/update', handler=handlers.TaskHandler, handler_method='update', name = 'update_task', methods=['POST']),
                     webapp2.Route('/delete', handler=handlers.TaskHandler, handler_method='delete', name = 'delete_task', methods=['POST']),
                     webapp2.Route('', handler=handlers.TaskHandler, handler_method='get', name='get_task'),
                  ]),
                 webapp2.Route('', handler=handlers.TaskHandler, handler_method='list'),
                            
             ])
slot_route = routes.PathPrefixRoute('/slots', [
                 webapp2.Route('/create', handler = handlers.SlotHandler, handler_method = 'create', name = 'create_slot'),
                 webapp2.Route('/list', handler=handlers.SlotHandler, handler_method = 'list', name = 'all_slots'),                                           
                 routes.PathPrefixRoute('/<slot_id:[\d]+>', [
                     webapp2.Route('/update', handler = handlers.SlotHandler, handler_method = 'update', name = 'update_slot', methods=['POST']),
                     webapp2.Route('/delete', handler = handlers.SlotHandler, handler_method = 'delete', name = 'delete_slot',  methods=['POST']),
                     webapp2.Route('/executed/<executed:[0-1]>', handler=handlers.SlotHandler, handler_method = 'set_executed', name = 'set_executed_slot', methods=['POST']),
                     webapp2.Route('', handler = handlers.SlotHandler, handler_method = 'get', name='get_slot')
                 ]),
                 webapp2.Route('', handler=handlers.SlotHandler, handler_method = 'list')
                                            
             ])

day_route = routes.PathPrefixRoute('/days', [
                webapp2.Route('/list', handler=handlers.DayHandler, handler_method = 'list', name='all_days'),
                routes.PathPrefixRoute('/<day_id:[1-7]>', [ 
                    slot_route,
                    webapp2.Route('', handler=handlers.DayHandler, handler_method= 'get', name='get_day')
                ]),
                webapp2.Route('', handler=handlers.DayHandler, handler_method='list')
                                
            ])
                                
schedule_route = routes.PathPrefixRoute('/schedules', [
                                                      
                     routes.PathPrefixRoute('/<schedule_id:[\w]+>', [
                         day_route,
                         webapp2.Route('/restart', handler=handlers.ScheduleHandler, handler_method='restart', name='restart_schedule'), 
                         webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get', name='get_schedule')
                     ]),
                     
                     webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get')
                 ])

crons_route = routes.PathPrefixRoute('/crons', [
                  webapp2.Route('/restart/weekly', handler = handlers.CronHandler)
              ])

applications_routes = [ webapp2.Route('/', handlers.MainHandler, name='main'),
                        crons_route,
                        routes.PathPrefixRoute('/api', [
                            task_route,
                            schedule_route
                        ])
                      ]

