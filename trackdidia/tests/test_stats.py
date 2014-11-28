'''
Created on 2014-11-21

@author: didia
'''
import unittest
from base_test import TestTracking
from trackdidia.models import stats

class TestStats(TestTracking):


    def testGetStat(self):
        stat = stats.get_stat(self.week)
        self.assertEquals(0, stat['result'])
        task = self.user.create_task("Eating")
        day = self.week.get_day(2)
        scheduled_task = day.add_scheduled_task(task, 20, 10);
        day.set_executed(scheduled_task.key.integer_id())
        stat = stats.get_stat(self.week)
        self.assertEquals(5.0, stat['result'])
        day = self.week.get_day(3)
        scheduled_task = day.add_scheduled_task(task, 30, 5)
        day.set_executed(scheduled_task.key.integer_id())
        stat = stats.get_stat(self.week)
        self.assertEquals(7.5, stat['result'])
    
    def testGetHtmlMessage(self):
        stat = stats.get_stat(self.week)
        htmlMessage = stats.get_html_message(stat)
        self.assertNotEquals(-1,htmlMessage.find("<html>"))
    
    def testGetPlainMessage(self):
        stat = stats.get_stat(self.week)
        plainMessage = stats.get_plain_message(stat)
        self.assertEquals(-1, plainMessage.find("<html>"))
    
    def testSendStat(self):
        message_body = stats.send_stat(self.user, self.week)
        self.assertNotEquals(-1, message_body.find("Here is your result"))

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()