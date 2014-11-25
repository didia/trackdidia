'''
Created on 2014-11-24

@author: didia
'''
import unittest
import webapp2;
from base_test import TestTracking
import trackdidia.main as main
from django.utils import simplejson
import os

class TestHandler(TestTracking):
    def setUp(self):
        super(TestHandler, self).setUp()
        os.environ['USER_EMAIL'] = self.user.email
        os.environ['USER_ID'] = self.user.key.id()
    def checkFieldExist(self, expected_fields, dict_object):
        if type(expected_fields) is dict:
            if not all (x in dict_object for x in expected_fields.keys()):
                return False
            for key, value in expected_fields.iteritems():
                if not (all(x in dict_object[key] for x in value)):
                    return False
            return True
        else:
            return all(x in dict_object for x in expected_fields)
        
class TestMainHandler(TestHandler):

    def testDiscover(self):
        url = "/api/enter"
        expected_fields = {"links":["schedule", "tasks", "create_task"]}
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))
        

class TestTaskHandler(TestHandler):
    def setUp(self):
        super(TestTaskHandler, self).setUp()
        self.task = self.user.create_task("Work")
    
    def testCreate(self):
        url = "/api/tasks/create"
        expected_fields = {"id":[], "name":[], "links":["get_task", "update_task"]}
        
        request = webapp2.Request.blank(url)
        request.method = "POST"
        request.body = "name=Peps"
        
        # Test a valid create request
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertEquals("Peps", response_dict['name'])
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))
        
        #Test an invalid request method
        request.method = "GET"
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 405)
        
        request.method = "POST"
        
        #Test an invalid request with duplicate task name
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 400)
        
        #Test with a request without the name request param
        request.body = ""
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 400)
    
    def testGet(self):
        url = "/api/tasks/{}".format(self.task.key.id())
        
        request = webapp2.Request.blank(url)
        
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(self.task.name, response_dict["name"])
    
    def testUpdate(self):
        url = "/api/tasks/{}/update".format(self.task.key.id())
        
        request = webapp2.Request.blank(url)
        request.method = "POST"
        request.body = "name=Dinner&description=Dinner+avec+Kevin"
        
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertEquals("Dinner", response_dict['name'])
        self.assertEquals("Dinner avec Kevin", response_dict['description'])
        #check if data has been persisted
        self.task = self.task.key.get()
        self.assertEquals("Dinner", self.task.name)
        self.assertEquals("Dinner avec Kevin", self.task.description)
        
        #fail when executing with a bad method, GET
        request.method = "GET"
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 405)
        
        request.method = "POST"
        #Now test update with existing task name
        request.body = "name=Sleep"
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 400)
        
        #Now test when no data is provided
        request.body = ""
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 400)
    
    def testList(self):
        url = "/api/tasks/list"
        request = webapp2.Request.blank(url)
        
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(len(self.user.get_all_tasks()), len(response_dict["tasks"]))
        
        
        
        

        
        
        
class TestScheduleHandler(TestHandler):
    pass

class TestDayHandler(TestHandler):
    pass

class TestSlotHandler(TestHandler):
    pass


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()