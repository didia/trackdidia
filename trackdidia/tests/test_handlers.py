'''
Created on 2014-11-24

@author: didia
'''
import unittest
import webapp2;
from base_test import TestTracking
import trackdidia.main as main
from django.utils import simplejson
class TestHandler(TestTracking):
    def setUp(self):
        super(TestTracking, self).setUp()
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
        

class TestScheduleHandler(TestHandler):
    pass

class TestDayHandler(TestHandler):
    pass

class TestSlotHandler(TestHandler):
    pass


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()