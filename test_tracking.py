'''
Created on 2014-10-28

@author: didia
'''
import unittest
from base_test import DatastoreTest
import user
from tracking import Schedule
import datetime

class TestTracking(DatastoreTest):
    
    def setUp(self):
        super(TestTracking, self).setUp()
        self.user = user.create_user('TheFuture', 'thefuture2092@gmail.com', 'Aristote')
    
        
        
        
        
    
if __name__ == '__main__':
    unittest.main()