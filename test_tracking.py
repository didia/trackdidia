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
    
    def test_schedule_initialize(self):
        schedule = Schedule(id='recurrent', parent = self.user.key)
        schedule.initialize()
    
    def test_schedule_set_starting_ending_date(self):
        schedule = Schedule(id='recurrent', parent = self.user.key)
        schedule.set_starting_ending_date(today=datetime.datetime(2014,10,29))
        self.assertEqual(datetime.datetime(2014,10,27), schedule.starting_date)
        self.assertEqual(datetime.datetime(2014,11,2), schedule.ending_date)
        
        
        
    
if __name__ == '__main__':
    unittest.main()