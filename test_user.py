#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''

import unittest
from base_test import DatastoreTest
import user
from tracking import Schedule

class TestUser(DatastoreTest):
    
    def setUp(self):
        super(TestUser, self).setUp()
        self.user = user.create_user("testeur", "testeur@gmail.com", "TestMan")
        
    def test_create_user(self):
        user_id = "145861"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        self.assertIsNotNone(my_user);
        same_user = user.get_user(user_id)
        self.assertEqual(user_id, same_user.get_id())
        self.assertEqual(email, same_user.get_email())
        self.assertEqual(nickname, same_user.get_nickname())
        
        #Test initialization of a schedule with default task for each dayOfWeek
        schedule = same_user.getSchedule()
        days = schedule.get_all_days()
        self.assertEqual(7, len(days))
        self.assertEqual(12, days[0].interval_usage.count(True))
        
        
    
    def test_get_user(self):
        user_id = "189567"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        self.assertEqual(my_user, user.get_user(user_id))
    
    def test_user_update(self):
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update(nickname = "aristodj")
        same_user = user.get_user(user_id)
        self.assertEqual("aristodj", same_user.get_nickname())
    
    def test_user_update_no_parameter(self):
        #it should do nothing
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update()
        same_user = user.get_user(user_id)
        self.assertEqual("TheFuture", same_user.get_nickname())
    
    def test_user_update_paremeter_none(self):
        #it should do nothing
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        my_user.update(nickname=None)
        same_user = user.get_user(user_id)
        self.assertEqual("TheFuture", same_user.get_nickname())
        
    def test_delete_user(self):
        user_id = "20000"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        user.create_user(user_id, email, nickname)
        user.delete_user(user_id)
        self.assertIsNone(user.get_user(user_id))
    
    def test_user_create_task(self):
        name = "GLO_2100"
        description = "Etude Algorithmes et Structure"
        location = "PLT-3920"
        my_task = self.user.create_task(name=name, description=description, location=location)
        self.assertEqual(my_task.name, name)
        self.assertEqual(my_task.description, description)
        self.assertEqual(my_task.location, location)
    
    def test_user_get_task(self):
        name = "GLO-2100"
        my_task = self.user.create_task(name = name)
        self.assertEqual(my_task, self.user.get_task(task_id = my_task.key.id()))

    def test_delete_task(self):
        name = "GLO-2100"
        my_task = self.user.create_task(name = name)
        self.user.delete_task(task_id = my_task.key.id())
        self.assertIsNone(self.user.get_task(task_id = my_task.key.id()))     
        
        
   
        
        
    
        
        
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()