from xml.sax.saxutils import escape
from django.utils import simplejson
from collections import OrderedDict
import logging
import webapp2
import os
import jinja2
from google.appengine.api import users
import datetime
from google.appengine.ext import ndb
import models.user as user_module
from models.custom_exceptions import HandlerException, RessourceNotFound,\
    NotImplementedYet
import traceback

jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader(os.path.dirname(__file__)))


def required_params(params):
    def real_decorator(handler):
        def check_required_params(self, *args, **kwargs):
            missing_params = []
            for param in params:
                if not self.request.get(param):
                    missing_params.append(param)
            if len(missing_params) != 0:
                message = ','.join(missing_params) + " are missing in the request"
                raise HandlerException(message)
            
            return handler(self, *args, **kwargs)
        
        return check_required_params
    return real_decorator
             
class BaseHandler(webapp2.RequestHandler):

    @webapp2.cached_property
    def user(self):
        """Shortcut to access the current logged in user.

        Unlike user_info, it fetches information from the persistence layer and
        returns an instance of the underlying model.

        :returns
          The instance of the user model associated to the logged in user.
        """
        user_instance = users.get_current_user()
        
        return user_module.get_or_create_user(user_instance.user_id(), user_instance.email(), user_instance.nickname())
    
    
    def render_template(self, view_filename, **kwargs):
        context = dict()
        context['user'] = self.user.user.nickname()
        context['url_to_create_task'] = webapp2.uri_for('create_task')
        context.update(kwargs)
        jtemplate = jinja_environment.get_template(view_filename)
        self.response.out.write(jtemplate.render(context))
    
    def cleanPostedData(self, listOfNamesOfDataToClean):
        """
        Function to clean arguments from html markups 
        
        :param properties:
            A list of arguments name we must clean
        :return edited_values:
            Dict that will contain the cleaned values
        """
        edited_values = {}
        for value in listOfNamesOfDataToClean:
                if self.request.get(value):
                    edited_values[value] = escape(self.request.get(value))
        return edited_values
    
    
    def handle_exception(self, exception, debug):
        # Log the error.
        logging.exception(exception)

        # Set a custom message.
        if debug:
            self.response.write(str(exception))
        else:
            if isinstance(exception, HandlerException):
                self.response.write(str(exception))
            else:
                self.response.write("An error occured. Our team will be notified. We apologize for the incovenience")

        # If the exception is a HTTPException, use its error code.
        # Otherwise use a generic 500 error code.
        if isinstance(exception, webapp2.HTTPException):
            self.response.set_status(exception.code)
        elif isinstance(exception, RessourceNotFound):
            self.response.set_status(404)
        elif isinstance(exception, NotImplementedYet):
            self.response.set_status(501)
        elif isinstance(exception, HandlerException):
            self.response.set_status(400)
        else:
            self.response.set_status(500)
    
    def send_json(self, response):
        self.response.out.write(simplejson.dumps(response))
    
    def send_json_success(self):
        self.response.out.write(simplejson.dumps("Operation Successfully executed"))
    
       
class MainHandler(BaseHandler):
    
    def get(self):
        schedule = self.user.get_schedule().get_representation()
        self.send_json(schedule)
        
    def get_template_context(self):
        context = dict()
        return context
    

class TaskHandler(BaseHandler):
    def create(self):
        white_listed_params = ['category', 'priority', 'name', 'description', 'location']
        params = self.cleanPostedData(white_listed_params)
        name = params.pop('name')
        task = self.user.create_task(name, **params)
        self.send_json(task.get_representation())
    
    def get(self, task_id):
        task = self.user.get_task(long(task_id))
        self.send_json(task.get_representation())
    
    def update(self, task_id):
        white_listed_params = ['category', 'priority', 'name', 'description', 'location']
        params = self.cleanPostedData(white_listed_params)
        task = self.user.update_task(long(task_id), **params)
        
        self.send_json(task.get_representation())
    
    def delete(self):
        raise NotImplementedYet
    
    def list(self):
        tasks = [task.get_representation() for task in self.user.get_all_tasks()]
        response = OrderedDict()
        response['found'] = len(tasks)
        response['tasks'] = tasks
        
        self.send_json(response)
          
class ScheduleHandler(BaseHandler):
    
    def create(self):
        raise NotImplementedYet
    
    def get(self, schedule_id = 'recurrent'):
        schedule = self.user.get_schedule(schedule_id)
        self.send_json(schedule.get_representation())
    
    def list(self):
        raise NotImplementedYet
    
    def update(self):
        raise NotImplementedYet
    
    def delete(self, schedule_id):
        raise NotImplementedYet

class DayHandler(BaseHandler):
    
    def get(self, day_id, schedule_id = 'recurrent'):
        schedule = self.user.get_schedule(schedule_id)
        if(schedule is None):
            raise RessourceNotFound('The schedule with id : ' + schedule_id + ' does not exist')
        
        day = schedule.get_day(long(day_id))
        self.send_json(day.get_representation())
    
    def list(self, schedule_id = 'recurrent'):
        schedule = self.user.get_schedule(schedule_id)
        days = schedule.get_all_days()
        response = [day.get_representation() for day in days]
        self.send_json(response)
    
    
class SlotHandler(BaseHandler):
    
    @required_params(['duration', 'offset', 'task_id'])
    def create(self, day_id, schedule_id = 'recurrent'):
        white_listed_params = ['duration', 'offset', 'task_id']
        params = self.cleanPostedData(white_listed_params)
        task_id = long(params['task_id'])
        duration = int(params['duration'])
        offset = int(params['offset'])
        slot = self.user.schedule_task(task_id, int(day_id), offset, duration, schedule_id)
        
        self.send_json(slot.get_representation())
    
    def get(self, day_id, slot_id, schedule_id = 'recurrent'): 
        slot = self._get_slot(schedule_id, long(slot_id), int(day_id))
        
        self.send_json(slot.get_representation())
    
    def list(self, day_id, schedule_id = 'recurrent'):
        day = self._get_day(schedule_id, day_id)
        slots = day.get_slots()
        response = [slot.get_representation() for slot in slots]
        
        self.send_json(response)
    
    
    def update(self, day_id, slot_id, schedule_id = 'recurrent'):
        raise NotImplementedYet
        params = self._get_allowed_params()
        day = self._get_day(schedule_id, day_id)
        slot = day.update_slot(len(slot_id), **params)
        
        self.send_json(slot.get_representation())
        
    def delete(self, day_id, slot_id, schedule_id = 'recurrent'):
        self.user.unschedule_task(day_id = int(day_id), slot_id = int(slot_id), schedule_id=schedule_id)
        self.send_json_success()
    
    def set_executed(self, day_id, slot_id, executed, schedule_id = 'recurrent'):
        schedule = self.user.get_schedule(schedule_id)
        executed = executed == '1'
        schedule.set_executed(int(day_id), long(slot_id), executed)
        
        self.send_json_success()
    
    def _get_allowed_params(self):
        white_listed_params = ['duration', 'offset', 'executed' 'task_id']
        params = self.cleanPostedData(white_listed_params)
        return params  
    
    
    def _get_slot(self, schedule_id, slot_id, day_id):
        day = self._get_day(schedule_id, day_id)
        slot = day.get_slot(long(slot_id))
        if slot is None:
            raise RessourceNotFound('The slot with id : '+ str(slot_id) + ' does not exist')
            
        return slot
    
    def _get_day(self, schedule_id, day_id):
        schedule = self.user.get_schedule(schedule_id)
        day = schedule.get_day(long(day_id))
        return day
        