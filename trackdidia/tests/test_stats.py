'''
Created on 2014-11-21

@author: didia
'''
import unittest
from base_test import TestTracking
from trackdidia.models import stats

class TestStats(TestTracking):


    def testGetStat(self):
        stat = stats.get_stat(self.schedule)
        self.assertEquals(0, stat['result'])
        task = self.user.create_task("Eating")
        day = self.schedule.get_day(2)
        slot = day.add_slot(task, 20, 10);
        day.set_executed(slot.key.integer_id())
        stat = stats.get_stat(self.schedule)
        self.assertEquals(5.0, stat['result'])
        day = self.schedule.get_day(3)
        slot = day.add_slot(task, 30, 5)
        day.set_executed(slot.key.integer_id())
        stat = stats.get_stat(self.schedule)
        self.assertEquals(7.5, stat['result'])
    
    def testGetHtmlMessage(self):
        stat = stats.get_stat(self.schedule)
        htmlMessage = stats.get_html_message(stat)
        self.assertNotEquals(-1,htmlMessage.find("<html>"))
    
    def testGetPlainMessage(self):
        stat = stats.get_stat(self.schedule)
        plainMessage = stats.get_plain_message(stat)
        self.assertEquals(-1, plainMessage.find("<html>"))

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()