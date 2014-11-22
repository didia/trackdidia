'''
Created on 2014-11-21

@author: didia
'''
import unittest
import webapp2
from base_test import TestTracking
from trackdidia.controllers import response_producer
from trackdidia import main

class TestResponseProducer(TestTracking):
    def setUp(self):
        super(TestResponseProducer, self).setUp();
        self.task = self.user.create_task("Test Response Producer")
        self.day = self.schedule.get_day(1)
        self.slot = self.day.add_slot(self.task, 20, 10)
        self.request = webapp2.Request.blank("/")
        self.request.app = main.app
        
    def testScheduleResponse(self):
        expected_response_attributes = ['schedule_id', 'interval', 'starting_date', 'ending_date','days',
                               'links']
        expected_links = ['get_schedule', 'stat', 'restart'] 
        response = response_producer.produce_schedule_response(self.request, self.schedule)
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
        
    def testProduceDayResponse(self):
        expected_response_attributes = ['day_id', 'interval_usage', 'slots', 'links']
        expected_links = ['get', 'create_slot', 'all_slots'] 
        response = response_producer.produce_day_response(self.request, self.day, self.schedule.key.id())
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
    
    def testSlotResponse(self):
        expected_response_attributes = ['slot_id', 'offset', 'duration', 'executed', 'task_id', 'links']
        expected_links = ['get', 'update', 'delete', 'set_executed'] 
        response = response_producer.produce_slot_response(self.request, self.slot, self.day.key.id(), self.schedule.key.id())
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
        
    def testProduceTaskResponse(self):
        expected_response_attributes = ['id', 'name', 'links']
        expected_links = ['get_task', 'update_task'] 
        response = response_producer.produce_task_response(self.request, self.task)
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
    
if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()