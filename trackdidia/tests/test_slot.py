'''
Created on 2014-11-20

@author: didia
'''
import unittest
from .base_test import TestTracking

class TestSlot(TestTracking):
    def testSetExecuted(self):
        task = self.user.create_task("Manger")
        day = self.schedule.get_day(1)
        slot = day.add_slot(task, 30, 10)
        self.assertFalse(slot.executed)
        slot.set_executed(True)
        slot = day.get_slot(slot.key.integer_id())
        self.assertTrue(slot.executed)


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()