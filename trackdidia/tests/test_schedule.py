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
    
    def testRestart(self):
        task = self.user.create_task("Test task")
        for day in self.schedule.get_all_days():
            slot = day.add_slot(task, 20, 8)
            slot.set_executed(True)
        
        self.schedule.restart()
        for day in self.schedule.get_all_days():
            self.assertFalse(all(x.executed for x in day.get_slots()))
            

    
if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()