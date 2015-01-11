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
                     webapp2.Route('/update', handler=handlers.TaskHandler, handler_method='update', name = 'update_task', methods=['POST', 'PUT']),
                     webapp2.Route('/delete', handler=handlers.TaskHandler, handler_method='delete', name = 'delete_task', methods=['POST', 'DELETE']),
                     webapp2.Route('', handler=handlers.TaskHandler, handler_method='get', name='get_task' ,methods=['GET', 'POST']),
                     webapp2.Route('', handler=handlers.TaskHandler, handler_method='update', methods=['PUT']),
                     webapp2.Route('', handler=handlers.TaskHandler, handler_method='delete', methods = ['DELETE'])
                  ]),
                 webapp2.Route('', handler=handlers.TaskHandler, handler_method='list'),
                            
             ])
slot_route = routes.PathPrefixRoute('/scheduled-tasks', [
                 webapp2.Route('/create', handler = handlers.ScheduledTaskHandler, handler_method = 'create', name = 'create_scheduled_task', methods=['POST']),
                 webapp2.Route('/list', handler=handlers.ScheduledTaskHandler, handler_method = 'list', name = 'all_scheduled_tasks'),                                           
                 routes.PathPrefixRoute('/<scheduled_task_id:[\d]+>', [
                     webapp2.Route('/update', handler = handlers.ScheduledTaskHandler, handler_method = 'update', name = 'update_scheduled_task', methods=['POST']),
                     webapp2.Route('/delete', handler = handlers.ScheduledTaskHandler, handler_method = 'delete', name = 'delete_scheduled_task',  methods=['POST']),
                     webapp2.Route('/executed/<executed:[0-1]>', handler=handlers.ScheduledTaskHandler, handler_method = 'set_executed', name = 'set_executed_scheduled_task', methods=['POST']),
                     webapp2.Route('', handler = handlers.ScheduledTaskHandler, handler_method = 'get', name='get_scheduled_task')
                 ]),
                 webapp2.Route('', handler=handlers.ScheduledTaskHandler, handler_method = 'list')
                                            
             ])

day_route = routes.PathPrefixRoute('/days', [
                webapp2.Route('/list', handler=handlers.DayHandler, handler_method = 'list', name='all_days'),
                routes.PathPrefixRoute('/<day_id:[1-7]>', [ 
                    slot_route,
                    webapp2.Route('', handler=handlers.DayHandler, handler_method= 'get', name='get_day')
                ]),
                webapp2.Route('', handler=handlers.DayHandler, handler_method='list')
                                
            ])
                                
schedule_route = routes.PathPrefixRoute('/weeks', [
                                                      
                     routes.PathPrefixRoute('/<week_id:[\w]+>', [
                         day_route,
                         webapp2.Route('/stat', handler=handlers.ScheduleHandler, handler_method = 'stat', name = 'get_week_stat'),
                         webapp2.Route('/restart', handler=handlers.ScheduleHandler, handler_method='restart', name='restart_week'), 
                         webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get', name='get_week')
                     ]),
                     
                     webapp2.Route('', handler=handlers.ScheduleHandler, handler_method='get')
                 ])

stat_route = routes.PathPrefixRoute('/stats', [
                    webapp2.Route('/', handlers.StatHandler, handler_method='get'),
                    webapp2.Route('', handlers.StatHandler, handler_method='get', name='stats')
                                               ])

crons_route = routes.PathPrefixRoute('/crons', [
                  webapp2.Route('/restart/weekly', handler = handlers.CronHandler)
              ])

applications_routes = [ webapp2.Route('/', handlers.MainHandler, name='main'),
                        webapp2.Route('/trial', handlers.MainHandler, handler_method = 'trial', name='trial'),
                        webapp2.Route('/untrial', handlers.MainHandler, handler_method = 'untrial', name='untrial'),
                        crons_route,
                        routes.PathPrefixRoute('/api', [
                            webapp2.Route('/enter', handlers.MainHandler, handler_method = 'discover'),
                            task_route,
                            schedule_route,
                            stat_route
                        ])
                      ]

