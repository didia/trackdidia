#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-11-28

@author: didia
'''
import unittest
from .base_test import TestTracking
from trackdidia.models.calendar import Day
from trackdidia.models.custom_exceptions import SchedulingConflict
from trackdidia.models.custom_exceptions import BadArgumentError

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

class TestSchedule(TestTracking):

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
    
    def testAddRecurrence(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        start_offset = 18
        task = self.user.create_task("Dinner Time")
        
        day = self.week.get_day(i)
        scheduled_task = day.add_scheduled_task(task, start_offset, duration)
        weekly = self.user.get_week("weekly")
        
        #Raises an exception if the week used is not a recurrent week
        self.assertRaises(BadArgumentError, self.week.add_recurrence, scheduled_task =  scheduled_task, recurrence_type = "weekly")
        
        # Test weekly recurrence
        weekly.add_recurrence(scheduled_task, 'weekly')
        same_scheduled_task = weekly.get_day(i).get_scheduled_task(scheduled_task.key.id())
        self.assertIsNotNone(same_scheduled_task)
        
        #Test daily recurrence
        start_offset = 30
        task = self.user.create_task("Super Time")
        scheduled_task = self.week.get_day(1).add_scheduled_task(task, start_offset, duration)
        weekly.add_recurrence(scheduled_task, "daily")
        for i in range(i, 8):
            same_scheduled_task = weekly.get_day(i).get_scheduled_task(scheduled_task.key.id())
            self.assertIsNotNone(same_scheduled_task)
        for i in range(2, 8):
            same_scheduled_task = self.week.get_day(i).get_scheduled_task(scheduled_task.key.id())
            self.assertIsNotNone(same_scheduled_task)     
    
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
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()