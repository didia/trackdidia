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
from trackdidia.models import utils

class TestHandler(TestTracking):
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
    def testGet(self):
        url = "/"
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 302)
        
        os.environ['USER_EMAIL'] = self.user.email
        os.environ['USER_ID'] = self.user.key.id()
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        
    def testDiscover(self):
        url = "/api/enter"
        expected_fields = {"links":["schedule", "tasks", "create_task"]}
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))

class TestCronHandler(TestHandler):
    def testGet(self):
        url = "/crons/restart/weekly"
        os.environ['USER_EMAIL'] = self.user.email
        os.environ['USER_ID'] = self.user.key.id()
        task = self.user.create_task("Fifa time")
        day = self.schedule.get_day(1)
        slot = day.add_slot(task, 30, 5)
        slot.set_executed(True)
        self.assertNotEquals(0, len(day.get_executed_slots()))
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        day = self.schedule.get_day(1)
        self.assertEquals(0, len(day.get_executed_slots()))
        
class TestApiHandler(TestHandler):
    def setUp(self):
        super(TestApiHandler, self).setUp()
        os.environ['USER_EMAIL'] = self.user.email
        os.environ['USER_ID'] = self.user.key.id()
                
                
class TestTaskHandler(TestApiHandler):
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
        
        #test with non existing task
        url = "/api/tasks/11111111"
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 404)
    
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
        
        
        
        

        
        
        
class TestScheduleHandler(TestApiHandler):
    
    def testGet(self):
        url = "/api/schedules/recurrent"
        
        request = webapp2.Request.blank(url)
        
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(7, len(response_dict["days"]))
        
        #Test non existiing schedule
        url = "/api/schedules/non-existing"
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 404)
    
    def testRestart(self):
        day = self.schedule.get_day(1)
        day2 = self.schedule.get_day(4)
        for slot in day.get_slots() + day2.get_slots():
            slot.set_executed(True)
        self.assertNotEquals(0, len(day.get_executed_slots()))
        self.assertNotEquals(0, len(day2.get_executed_slots()))
        
        url = "/api/schedules/recurrent/restart"
        request = webapp2.Request.blank(url)
        
        response = request.get_response(main.app)
        self.assertEquals(response.status_int, 200)
        
        self.assertEquals(0, len(day.get_executed_slots()))
        self.assertEquals(0, len(day2.get_executed_slots()))
    
    def testStat(self):
        url = "/api/schedules/recurrent/stat"
        expected_fields = ['result', 'total', 'days']
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        
        self.assertEquals(response.status_int, 200)
        
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))    
        

class TestDayHandler(TestApiHandler):
    def testGet(self):
        url = "/api/schedules/recurrent/days/1"
        expected_fields = {'day_id':[], 'interval_usage':[], 'slots':[], 'links':['get', 'all_slots', 'create_slot']}
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        
        self.assertEquals(response.status_int, 200)
        
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))
        self.assertEquals(1, response_dict['day_id'])
    
    def testList(self):
        url = "/api/schedules/recurrent/days/list"
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        
        self.assertEquals(response.status_int, 200)
        
        response_list = simplejson.loads(response.body)
        self.assertEquals(7, len(response_list))

class TestSlotHandler(TestApiHandler):
    def testCreate(self):
        task = self.user.create_task("Fifa Time")
        url = "/api/schedules/recurrent/days/2/slots/create"
        expected_fields = {'slot_id':[], 'offset':[], 'duration':[], 'executed':[], 'task_id':[], 
                           'links':['get','update','delete','set_executed']}
        
        #Test with non valid method
        request = webapp2.Request.blank(url)
        request.method = "GET"
        response = request.get_response(main.app)
        self.assertEquals(405, response.status_int)
        
        request.method = "POST"
        
        #Test with missing required arguments
        request.body = "offset=20&task_id="+str(task.key.id())
        response = request.get_response(main.app)
        self.assertEquals(400, response.status_int)
        
        #Test with missing task_id and missing name
        request.body = "offset=20&duration=12"
        response = request.get_response(main.app)
        self.assertEquals(400, response.status_int)
        
        #Test with bad argument
        request.body = "offset=4&duration=4&name=Work"
        response = request.get_response(main.app)
        self.assertEquals(400, response.status_int)
        
        #Test create slot with task_id
        request.body = "offset=20&duration=12&task_id="+str(task.key.id())
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict))
        self.assertEquals(task.key.id(), response_dict['task_id'])
        self.assertEquals(20, response_dict['offset'])
        self.assertEquals(12, response_dict['duration'])
        
        #Test create slot with task_name
        request.body = "offset=40&duration=4&name=Work"
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertTrue(self.checkFieldExist(["task", "slot"], response_dict))
        self.assertEquals(response_dict['task']['id'], response_dict['slot']['task_id'])
        self.assertTrue(self.checkFieldExist(expected_fields, response_dict['slot']))
        self.assertEquals("Work", response_dict['task']['name'])

    def testGet(self):
        task = self.user.create_task("VolleyBall")
        slot = self.schedule.get_day(1).add_slot(task, 20, 20)
        url = "/api/schedules/recurrent/days/1/slots/" + str(slot.key.id())
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(slot.key.id(), response_dict['slot_id'])
        
        #Test with an invalid ID
        url = "/api/schedules/recurrent/days/1/slots/111111"
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(404, response.status_int)
        
    def testList(self):
        url = "/api/schedules/recurrent/days/1/slots/list"
        
        request = webapp2.Request.blank(url)
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_list = simplejson.loads(response.body)
        self.assertEquals(1, len(response_list))
    
    def testDelete(self):
        task = self.user.create_task("VolleyBall")
        slot = self.schedule.get_day(1).add_slot(task, 20, 20)
        url = "/api/schedules/recurrent/days/1/slots/" + str(slot.key.id()) + "/delete"
        
        request = webapp2.Request.blank(url)
        request.method = "POST"
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(1, response_dict['day_id'])
        self.assertIsNone(self.schedule.get_day(1).get_slot(slot.key.id()))
        
    def testSetExecuted(self):
        today_id = utils.get_today_id()
        day = self.schedule.get_day(today_id)
        task = self.user.create_task("VolleyBall")
        slot = day.add_slot(task, 20, 20)
        url = "/api/schedules/recurrent/days/"+str(day.key.id())+"/slots/" + str(slot.key.id()) + "/executed/"
        
        self.assertFalse(slot.executed)
        request = webapp2.Request.blank(url+"1")
        request.method = "POST"
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(True, response_dict['executed'])
        self.assertTrue(day.get_slot(slot.key.id()).executed)
        
        request = webapp2.Request.blank(url+"0")
        request.method = "POST"
        response = request.get_response(main.app)
        self.assertEquals(200, response.status_int)
        response_dict = simplejson.loads(response.body)
        self.assertEquals(False, response_dict['executed'])
        self.assertFalse(day.get_slot(slot.key.id()).executed)
        
        # test in case set executed of a task in the future
        if today_id != 8:
            day = self.schedule.get_day(today_id + 1)
            slot = day.add_slot(task, 20, 20)
            url = "/api/schedules/recurrent/days/"+str(day.key.id())+"/slots/" + str(slot.key.id()) + "/executed/"
            
            request = webapp2.Request.blank(url+"1")
            request.method = "POST"
            response = request.get_response(main.app)
            self.assertEquals(400, response.status_int)   
    


        
        

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()