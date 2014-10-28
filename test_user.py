#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-28

@author: didia
'''

import unittest
from base_test import DatastoreTest
import user

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
    
    def test_get_user(self):
        user_id = "189567"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        self.assertEqual(my_user, user.get_user(user_id))
    
    def test_edit_user(self):
        user_id = "19999"
        email = "thefuture2092@gmail.com"
        nickname = "TheFuture"
        my_user = user.create_user(user_id, email, nickname)
        user.update_user(my_user.get_id(), nickname="aristodj")
        same_user = user.get_user(user_id)
        self.assertEqual("aristodj", same_user.get_nickname())
    
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