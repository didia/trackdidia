'''
Created on 2014-11-20

@author: didia
'''
import unittest
from .base_test import TestTracking
from trackdidia.models.custom_exceptions import BadArgumentError
class TestSchedule(TestTracking):


    def testSchedule_get_day(self):
        i = 1  
        day = self.schedule.get_day(i)
        self.assertIsNotNone(day)
        self.assertEqual(i, day.key.integer_id())
    
    def testSchedule_get_slots(self):
        i = 2
        day = self.schedule.get_day(i)
        slots = day.get_slots()
        self.assertIsNotNone(slots)
        self.assertEqual(1, len(slots))

    def testSchedule_add_slot(self):
        task = self.user.create_task("Fifa time")
        
        #Don't raise
        self.schedule.add_slot(task, 4, 20, 5)
        
        #Bad day_id
        self.assertRaises(BadArgumentError, self.schedule.add_slot, task, 9, 20, 5)
        self.assertRaises(BadArgumentError, self.schedule.add_slot, task, 0, 20, 5)
        
        #Bad start_slot
        self.assertRaises(BadArgumentError, self.schedule.add_slot, task, 5, 60, 5)
        self.assertRaises(BadArgumentError, self.schedule.add_slot, task, 5, -5, 5)
        
        #Bad duration
        self.assertRaises(BadArgumentError, self.schedule.add_slot, task, 6, 43, 15)

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()