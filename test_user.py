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
        self.assertTrue(type(same_user.getSchedule()) is Schedule)
    
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
        
        
        
   
        
        
    
        
        
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()