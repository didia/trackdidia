#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-28

@author: didia
'''
import unittest
import datetime
from .base_test import TestTracking
from trackdidia.models.calendar import Day
from trackdidia.models.calendar import ScheduledTask
from trackdidia.models.custom_exceptions import SchedulingConflict
from trackdidia.models.custom_exceptions import BadArgumentError
from trackdidia.utils import utils
class TestScheduledTask(TestTracking):
    def testSetExecuted(self):
        task = self.user.create_task("Manger")
        day = self.week.get_day(1)
        scheduled_task = day.add_scheduled_task(task, 30, 10)
        self.assertFalse(scheduled_task.executed)
        scheduled_task.set_executed(True)
        scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
        self.assertTrue(scheduled_task.executed)

class TestDay(TestTracking):


    def testAddScheduledTask(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        start_offset = 18
        task = self.user.create_task("Dinner Time")

        day = self.week.get_day(i)
        day.add_scheduled_task(task, start_offset, duration)
        day.reload_scheduled_tasks()
        scheduled_tasks = day.get_scheduled_tasks()
        self.assertEqual(2, len(scheduled_tasks))
        self.assertEqual(12+duration, day.interval_usage.count(True))
        slot = scheduled_tasks[1]
        self.assertEqual(duration,slot.duration)
        self.assertEqual(start_offset, slot.offset)
    
    def testCloneScheduledTask(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        start_offset = 18
        task = self.user.create_task("Dinner Time")
        
        day = self.week.get_day(i)
        scheduled_task = day.add_scheduled_task(task, start_offset, duration)
        
        self.assertRaises(SchedulingConflict, day.clone_scheduled_task, scheduled_task = scheduled_task)
        i += 1
        day = self.week.get_day(i)
        day.clone_scheduled_task(scheduled_task)
        same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
        self.assertIsNotNone(same_scheduled_task)
        self.assertEqual(duration, same_scheduled_task.duration)
        self.assertEqual(start_offset, same_scheduled_task.offset)
    
    def testRemoveScheduledTask(self):
        i = 3
        day = self.week.get_day(i)
        scheduled_tasks = day.get_scheduled_tasks()
        slot_id = scheduled_tasks[0].key.id()
        day.remove_scheduled_task(slot_id)
        scheduled_tasks_now = day.get_scheduled_tasks()
        self.assertEqual(0, len(scheduled_tasks_now))
        self.assertEqual(0, day.interval_usage.count(True))
    
    def testValidateOffsetAndDuration(self):
        i = 2
        start_offset = 4
        duration = 2
    
        day = self.week.get_day(i)
        self.assertRaises(SchedulingConflict, day.validate_offset_and_duration, start_offset, duration)
        
        #Bad start_slot
        self.assertRaises(BadArgumentError, day.validate_offset_and_duration, 60, 5)
        self.assertRaises(BadArgumentError, day.validate_offset_and_duration, -5, 5)
        
        #Bad duration
        self.assertRaises(BadArgumentError, day.validate_offset_and_duration, 43, 15)
    
    def testGetScheduledTasks(self):
        i = 2
        day = self.week.get_day(i)
        scheduled_tasks = day.get_scheduled_tasks()
        self.assertIsNotNone(scheduled_tasks)
        self.assertEqual(1, len(scheduled_tasks))
    
    def testRestart(self):
        task = self.user.create_task("Fifa time")
        day = self.week.get_day(3)
        day.add_scheduled_task(task, 13, 3);
        day.add_scheduled_task(task, 16, 4);
        scheduled_tasks = day.get_scheduled_tasks();
        for scheduled_task in scheduled_tasks:
            scheduled_task.set_executed(True)
        
        self.assertTrue(all(x.executed for x in day.get_scheduled_tasks()))
        day.restart()
        self.assertFalse(all(x.executed for x in day.get_scheduled_tasks()))
    
    def testSetExecuted(self):
        task = self.user.create_task("Fifa time")
        day = self.week.get_day(4)
        scheduled_tasks = []
        scheduled_tasks.append(day.add_scheduled_task(task, 14, 7))
        scheduled_tasks.append(day.add_scheduled_task(task, 30, 5))
        self.assertFalse(all(x.executed for x in scheduled_tasks))
        day.set_executed(scheduled_tasks[0].key.id(), True)
        scheduled_task_0 = day.get_scheduled_task(scheduled_tasks[0].key.id())
        scheduled_task_1 = day.get_scheduled_task(scheduled_tasks[1].key.id())
        self.assertTrue(scheduled_task_0.executed)
        self.assertFalse(scheduled_task_1.executed)
        
        slots_dict = {}
        slots_dict[scheduled_task_0.key.id()] = False
        slots_dict[scheduled_task_1.key.id()] = True
        
        day.set_executed(slots_dict)
        
        scheduled_task_0 = day.get_scheduled_task(scheduled_tasks[0].key.id())
        scheduled_task_1 = day.get_scheduled_task(scheduled_tasks[1].key.id())
        
        self.assertFalse(scheduled_task_0.executed)
        self.assertTrue(scheduled_task_1.executed)
    
    def testGetAllExecutedScheduledTasks(self):
        task = self.user.create_task("Fifa time")
        day = self.week.get_day(5)
        scheduled_tasks = []
        scheduled_tasks.append(day.add_scheduled_task(task, 14, 7))
        scheduled_tasks.append(day.add_scheduled_task(task, 30, 5))
        self.assertEquals(0, len(day.get_executed_slots()))
        for scheduled_task in scheduled_tasks:
            scheduled_task.set_executed(True)
        executed_scheduled_tasks = day.get_executed_slots()
        self.assertEquals(2, len(executed_scheduled_tasks))
        self.assertTrue(all(scheduled_task in executed_scheduled_tasks for scheduled_task in scheduled_tasks))
    
    def testGetStat(self):
        day = self.week.get_day(2)
        stat = day.get_stat()
        self.assertEquals(0, stat[0])
        task = self.user.create_task("Eating")
        scheduled_task = day.add_scheduled_task(task, 20, 10);
        day.set_executed(scheduled_task.key.id())
        stat = day.get_stat()
        self.assertEquals(5.0, stat[0])

class TestWeek(TestTracking):

    def testGetDay(self):
        i = 1  
        day = self.week.get_day(i)
        self.assertIsNotNone(day)
        self.assertEqual(i, day.key.id())
    
    def testRestart(self):
        task = self.user.create_task("Test task")
        for day in self.week.get_all_days():
            scheduled_task = day.add_scheduled_task(task, 20, 8)
            scheduled_task.set_executed(True)
        
        self.week.restart()
        for day in self.week.get_all_days():
            self.assertFalse(all(x.executed for x in day.get_scheduled_tasks()))
    
    def testGetAllDays(self):
        days = self.week.get_all_days()
        self.assertEquals(7, len(days))
        for day in days:
            self.assertTrue(type(day) == Day)
    
     
    def testGetStat(self):
        stat = self.week.get_stat()
        self.assertEquals(0, stat[0])
        task = self.user.create_task("Eating")
        day = self.week.get_day(2)
        scheduled_task = day.add_scheduled_task(task, 20, 10);
        day.set_executed(scheduled_task.key.integer_id())
        stat = self.week.get_stat()
        self.assertEquals(5.0, stat[0])
        day = self.week.get_day(3)
        scheduled_task = day.add_scheduled_task(task, 30, 5)
        day.set_executed(scheduled_task.key.integer_id())
        stat = self.week.get_stat()
        self.assertEquals(7.5, stat[0])

    def testAddRecurrence(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        start_offset = 18
        task = self.user.create_task("Dinner Time")
        
        day = self.week.get_day(i)
        scheduled_task = day.add_scheduled_task(task, start_offset, duration)
        weekly = self.user.get_week("weekly")
        
        #Raises an exception if the week used is not a recurrent week
        self.assertRaises(BadArgumentError, self.week.add_recurrence, scheduled_task =  scheduled_task)
        
        # Test recurrent week
        try:
            weekly.add_recurrence(scheduled_task)
        except Exception:
            self.fail("add_recurrence raised an exception when called with a recurrent week")
    
    def testDeleteRecurrence(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
        
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, 'daily')
        
        #Raises an exception if the week used is not a recurrent week
        self.assertRaises(BadArgumentError, self.week.delete_recurrence, scheduled_task =  scheduled_task)

        # Test recurrent week
        weekly = self.user.get_week("weekly")
        try:
            weekly.delete_recurrence(scheduled_task)
        except Exception:
            self.fail("delete_recurrence raised an exception when called with a recurrent week") 
    
    def testDeleteWeeklyRecurrence(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
        
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, 'weekly')        
        weekly = self.user.get_week("weekly")
         
        weekly.delete_recurrence(scheduled_task)
         
        self.assertIsNone(weekly.get_day(i).get_scheduled_task(scheduled_task.key.id()))
    
    def testDeleteDailyRecurrence(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
        
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, 'daily')        
        weekly = self.user.get_week("weekly")
         
        weekly.delete_recurrence(scheduled_task)
        
        for day in weekly.get_all_days():
            same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
            self.assertIsNone(same_scheduled_task)
               
    
    def testAddScheduledTaskWithoutRecurrence(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        scheduled_task = current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset)
        self.assertIsNotNone(scheduled_task)
        self.assertEquals(duration, scheduled_task.duration)
        self.assertEquals(offset, scheduled_task.offset)
        
        weekly = self.user.get_week('weekly')
        same_scheduled_task = weekly.get_day(day_id).get_scheduled_task(scheduled_task.key.id())
        self.assertIsNone(same_scheduled_task)
    
    def testAddScheduleTaskWithWeeklyRecurrence(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration = 6
        offset = 18
        current_schedule = self.user.get_week('current')
        scheduled_task = current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset, recurrence = 'weekly')
        self.assertIsNotNone(scheduled_task)
        
        weekly = self.user.get_week('weekly')
    
        same_scheduled_task = weekly.get_day(day_id).get_scheduled_task(scheduled_task.key.id())
        self.assertIsNotNone(same_scheduled_task)
        same_scheduled_tasks = []
        for day in weekly.get_all_days():
            same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
            if same_scheduled_task :
                same_scheduled_tasks.append(same_scheduled_task)
        self.assertEquals(1, len(same_scheduled_tasks))
    
    def testAddScheduleTaskWithDailyRecurrence(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration = 6
        offset = 18
        current_schedule = self.user.get_week('current')
        scheduled_task = current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset, recurrence = 'daily')
        self.assertIsNotNone(scheduled_task)
        
        weekly = self.user.get_week('weekly')
    
        same_scheduled_task = current_schedule.get_day(1).get_scheduled_task(scheduled_task.key.id())
        self.assertIsNone(same_scheduled_task)
        
        for i in range(day_id, 8):
            same_scheduled_task = current_schedule.get_day(i).get_scheduled_task(scheduled_task.key.id())
            self.assertIsNotNone(same_scheduled_task)
      
        for day in weekly.get_all_days():
            same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
            self.assertIsNotNone(same_scheduled_task)
    
    def testDeleteScheduledTaskWithoutRecurrence(self):
        i = 3
        day = self.week.get_day(i)
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
       
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, "daily")
        
        self.week.delete_scheduled_task(i, scheduled_task)
        
        self.assertIsNone(day.get_scheduled_task(scheduled_task.key.id()))
        weekly = self.user.get_week('weekly')
        for day in weekly.get_all_days():
            same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
            self.assertIsNotNone(same_scheduled_task)
    
    def testDeleteScheduledTaskWithDailyRecurrence(self):
        i = 3
        day = self.week.get_day(i)
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
       
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, "daily")
        
        scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
        
        self.week.delete_scheduled_task(i, scheduled_task, True)
        
        self.assertIsNone(day.get_scheduled_task(scheduled_task.key.id()))
        weekly = self.user.get_week('weekly')
        
        for k in range(i+1, 8):
            self.assertIsNone(self.week.get_day(k).get_scheduled_task(scheduled_task.key.id()))
        
        for day in weekly.get_all_days():        
            same_scheduled_task = day.get_scheduled_task(scheduled_task.key.id())
            self.assertIsNone(same_scheduled_task)
    
    def testDeleteScheduledTaskWithWeeklyRecurrence(self):
        i = 3
        day = self.week.get_day(i)
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        task = self.user.create_task("Dinner Time")
       
        scheduled_task = self.week.add_scheduled_task(i, task, offset, duration, "weekly")
        
        self.week.delete_scheduled_task(i, scheduled_task, True)
        
        self.assertIsNone(day.get_scheduled_task(scheduled_task.key.id()))
        weekly = self.user.get_week('weekly')
       
        same_scheduled_task = weekly.get_day(i).get_scheduled_task(scheduled_task.key.id())
        self.assertIsNone(same_scheduled_task)
    
    def testGetAllScheduledTasks(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset)
        all_scheduled_tasks = current_schedule.get_scheduled_tasks()
        self.assertEquals(8, len(all_scheduled_tasks))
    
    def testGetUniqueScheduledTasks(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset)
        all_scheduled_tasks = current_schedule.get_scheduled_tasks(unique = True)
        self.assertEquals(2, len(all_scheduled_tasks))
    
    def testGetNonExpiredTasks(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        current_schedule.add_scheduled_task(day_id = 1, task = task, duration = duration, offset = offset)
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset)
        current_schedule.add_scheduled_task(day_id = 3, task = task, duration = duration, offset = offset)
        utils.today = datetime.date(2014,10,29) #it's day 3
        
        all_scheduled_tasks = current_schedule.get_scheduled_tasks(active_only = False)
        self.assertEquals(10, len(all_scheduled_tasks)) 

        all_scheduled_tasks = current_schedule.get_scheduled_tasks(active_only = True)
        self.assertEquals(8, len(all_scheduled_tasks)) 
        utils.today = datetime.datetime.now()
    
    def testGetScheduledTasksByTask(self):
        day_id = 2
        task = self.user.create_task("Fifa Time")
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        offset = 18
        current_schedule = self.user.get_week('current')
        current_schedule.add_scheduled_task(day_id = day_id, task = task, duration = duration, offset = offset, recurrence = "daily")
        
        all_scheduled_tasks = current_schedule.get_scheduled_tasks(task_key = task.key)
        
        self.assertEquals(6, len(all_scheduled_tasks))
        

                        
                   
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()