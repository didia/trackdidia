#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''

import unittest
import datetime
from base_test import DatastoreTest
from trackdidia.models import user
from trackdidia.models.custom_exceptions import BadArgumentError
from trackdidia.models import utils

class TestUser(DatastoreTest): 
    def setUp(self):
        super(TestUser, self).setUp()
        self.user = user.create_user("testeur", "testeur@gmail.com", "TestMan")
    
    def testCreateWeek(self):
        utils.today = datetime.date(2014,10,29)
        monday, sunday = utils.get_week_start_and_end()
        schedule = self.user.get_or_create_week(monday, sunday)
        days = schedule.get_all_days()
        
        #Test if the expected structure of a week has been respected i.e 7 days
        # and a default 6 hour sleep scheduled_task
        self.assertEqual(7, len(days))
        self.assertEqual(12, days[0].interval_usage.count(True))
        
        
        #Test if the week id is really the expected id monday/saturday
        self.assertEqual("2014102720141102", schedule.key.id())
        
        
     
    def testCreateUser(self):
        user_id = "145861"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        self.assertIsNotNone(my_user);
        same_user = user.get_user(user_id)
        self.assertEqual(user_id, same_user.key.id())
        self.assertEqual(email, same_user.email)
        self.assertEqual(nickname, same_user.nickname)
        
        #Test initialization of a schedule with default task for each dayOfWeek
        schedule = same_user.get_week()
        days = schedule.get_all_days()
        self.assertEqual(7, len(days))
        self.assertEqual(12, days[0].interval_usage.count(True))
        
        
    
    def testGetUser(self):
        user_id = "189567"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        self.assertEqual(my_user, user.get_user(user_id))
    
    def testGetOrCreateUser(self):
        user_id = "23121992"
        email = "kevindias@gmail.com"
        nickname = "Kevin"
        
        self.assertIsNone(user.get_user(user_id))
        my_user = user.get_or_create_user(user_id, email, nickname)
        self.assertEquals(user_id, my_user.key.id())
    
    def testGetAllUsers(self):
        self.assertEquals(len(user.get_all_users()), 1)
        user.create_user("23121992", "kevindias@gmail.com", "Kevin")
        self.assertEquals(len(user.get_all_users()), 2)
        
    def testUpdate(self):
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update(nickname = "aristodj")
        same_user = user.get_user(user_id)
        self.assertEqual("aristodj", same_user.nickname)
    
    def testUpdateNoParameter(self):
        #it should do nothing
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update()
        same_user = user.get_user(user_id)
        self.assertEqual("TheFuture", same_user.nickname)
    
    def testUpdateParameterNone(self):
        #it should do nothing
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update(nickname=None)
        same_user = user.get_user(user_id)
        self.assertEqual("TheFuture", same_user.nickname)
        
    def testDeleteUser(self):
        user_id = "20000"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        user.create_user(user_id, email, nickname)
        user.delete_user(user_id)
        self.assertIsNone(user.get_user(user_id))
    
    def testCreateTask(self):
        name = "GLO_2100"
        description = "Etude Algorithmes et Structure"
        location = "PLT-3920"
        my_task = self.user.create_task(name=name, description=description, location=location)
        self.assertEqual(my_task.name, name)
        self.assertEqual(my_task.description, description)
        self.assertEqual(my_task.location, location)
        self.assertRaises(BadArgumentError, self.user.create_task, name)
    
    def testGetTask(self):
        name = "GLO-2100"
        my_task = self.user.create_task(name = name)
        self.assertEqual(my_task, self.user.get_task(task_id = my_task.key.integer_id()))

    def testGetTaskByName(self):
        name = "Sleep"
        my_task = self.user.get_task_by_name(name)
        self.assertIsNotNone(my_task)

    def testDeleteTask(self):
        name = "GLO-2100"
        my_task = self.user.create_task(name = name)
        self.user.delete_task(task_id = my_task.key.integer_id())
        self.assertIsNone(self.user.get_task(task_id = my_task.key.integer_id()))
    
    def testGetCurrentWeek(self):
        week_id = utils.get_week_id()
        current_week = self.user.get_current_week()
        self.assertEqual(week_id, current_week.key.id())
    

        
      
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()