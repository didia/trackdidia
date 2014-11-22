'''
Created on 2014-11-20

@author: didia
'''
import unittest
from .base_test import TestTracking


class TestSchedule(TestTracking):


    def testGetDay(self):
        i = 1  
        day = self.schedule.get_day(i)
        self.assertIsNotNone(day)
        self.assertEqual(i, day.key.integer_id())
    


    
if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()