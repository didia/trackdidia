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
        self.day = self.week.get_day(1)
        self.scheduled_task = self.day.add_scheduled_task(self.task, 20, 10)
        self.request = webapp2.Request.blank("/")
        self.request.app = main.app
        
    def testWeekResponse(self):
        expected_response_attributes = ['id', 'interval', 'starting_date', 'ending_date','days',
                               'links', 'stat']
        expected_links = ['get_week', 'stat', 'restart'] 
        response = response_producer.produce_week_response(self.request, self.week)
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
        
    def testProduceDayResponse(self):
        expected_response_attributes = ['id', 'interval_usage', 'scheduled_tasks', 'stat', 'links']
        expected_links = ['get', 'create_scheduled_task', 'all_scheduled_tasks'] 
        response = response_producer.produce_day_response(self.request, self.day, self.week.key.id())
        self.assertTrue(all(x in response for x in expected_response_attributes))
        self.assertTrue(all(x in response['links'] for x in expected_links))
    
    def testSlotResponse(self):
        expected_response_attributes = ['id', 'offset', 'duration', 'executed', 'task_id', 'recurrence', 'links']
        expected_links = ['get', 'update', 'delete', 'set_executed'] 
        response = response_producer.produce_scheduled_task_response(self.request, self.scheduled_task, self.day.key.id(), self.week.key.id())
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