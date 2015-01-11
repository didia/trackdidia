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
    
    def testComputeStressStatsForWeek(self):
        week = self.user.get_week()
        week_stat = stats.compute_stress_stats_for_week(week)
        self.assertEquals(24.0 * 7, week_stat['total'])
        self.assertEquals(6 *7, week_stat['result'])
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset, recurrence='daily')
        
        week_stat = stats.compute_stress_stats_for_week(week)
        
        self.assertEquals(24.0*7, week_stat['total'])
        self.assertEquals(6*7 + 6*3, week_stat['result'])   
             
    def testComputeStressStatsForDay(self):
        day_id = 2
        week = self.user.get_week()
        day = week.get_day(day_id)
        day_stat = stats.compute_stress_stats_for_day(day)
        self.assertEquals(24.0, day_stat['total'])
        self.assertEquals(6, day_stat['result'])
        
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset)
        
        day_stat = stats.compute_stress_stats_for_day(day)
        
        self.assertEquals(24.0, day_stat['total'])
        self.assertEquals(6 + 3, day_stat['result'])
        

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()