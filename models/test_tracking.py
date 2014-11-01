'''
Created on 2014-10-28

@author: didia
'''
import unittest
from base_test import DatastoreTest
import user
from tracking import Schedule
import datetime
from custom_exceptions import SlotAlreadyUsed, BadArgumentError

class TestTracking(DatastoreTest):
    
    def setUp(self):
        super(TestTracking, self).setUp()
        self.user = user.create_user('TheFuture', 'thefuture2092@gmail.com', 'Aristote')
        self.schedule = self.user.get_schedule()
    
    def testSchedule_get_day(self):
        i = 1  
        day = self.schedule.get_day(i)
        self.assertIsNotNone(day)
        self.assertEqual(i, day.key.id())
    
    def testSchedule_get_slots(self):
        i = 2
        day = self.schedule.get_day(i)
        slots = day.get_slots()
        self.assertIsNotNone(slots)
        self.assertEqual(1, len(slots))
    
    def testDayOfWeek_add_slots(self):
        i = 2
        duration= 6 # 6 interval . With interval = 0.5h, duration = 3 hours
        start_offset = 18
        task = self.user.create_task("Dinner Time")

        day = self.schedule.get_day(i)
        day.add_slot(task, start_offset, duration)
        day.reload_slots()
        slots = day.get_slots()
        self.assertEqual(2, len(slots))
        self.assertEqual(12+duration, day.interval_usage.count(True))
        slot = slots[1]
        self.assertEqual(duration,slot.duration)
        self.assertEqual(start_offset, slot.start_offset)
    
    def testDayOfWeek_remove_slot(self):
        i = 3
        day = self.schedule.get_day(i)
        slots = day.get_slots()
        slot_id = slots[0].key.id()
        day.remove_slot(slot_id)
        slots_now = day.get_slots()
        self.assertEqual(0, len(slots_now))
        self.assertEqual(0, day.interval_usage.count(True))
    
    def testDayOfWeek_add_slots_bad(self):
        i = 2
        start_offset = 4
        duration = 2
        task = self.user.create_task("Fifa time")
        
        day = self.schedule.get_day(i)
        self.assertRaises(SlotAlreadyUsed, day.add_slot, task, start_offset, duration)
    
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
        
        
        
        
        
        
    
        
        
        
        
    
if __name__ == '__main__':
    unittest.main()