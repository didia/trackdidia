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
import response_producer
from controllers.response_producer import produce_task_response,\
    produce_schedule_response, produce_day_response

jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader('views'))


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
        if not user_instance:
            self.redirect(users.create_login_url(self.request.uri))
        
        return user_module.get_or_create_user(user_instance.user_id(), user_instance.email(), user_instance.nickname())
    
    
    def render_template(self, view_filename, **kwargs):
        context = dict()
        context['user'] = self.user.nickname
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
    

class CronHandler(BaseHandler):
    def get(self):
        users = user_module.get_all_users()
        number_processed = 0
        for user in users:
            schedule = user.get_schedule()
            if schedule:
                schedule.restart()
                number_processed += 1
        
        self.response.out.write(str(number_processed) + " schedules restarted")
    
                
class MainHandler(BaseHandler):
    
    def get(self):
        
        self.render_template('index.html')
        
    def get_template_context(self):
        context = dict()
        return context
    
    def discover(self):
        links = {}
        links['schedule'] = self.uri_for('get_schedule', schedule_id='recurrent')
        links['tasks'] = self.uri_for('all_tasks')
        
        self.send_json({'links':links})
    

class TaskHandler(BaseHandler):
    ALLOWED_PARAMS = ['category', 'priority', 'name', 'description', 'location']
    
    def create(self):
        params = self._get_allowed_params()
        name = params.pop('name')
        task = self.user.create_task(name, **params)
        response = response_producer.produce_task_response(self.request, task)
        self.send_json(self._wrap_response(response))
    
    def get(self, task_id):
        task = self.user.get_task(long(task_id))
        
        response = response_producer.produce_task_response(self.request, task)
        self.send_json(self._wrap_response(response))
    
    def update(self, task_id):
        params = self._get_allowed_params()
        task = self.user.update_task(long(task_id), **params)
        response = response_producer.produce_task_response(self.request, task)
        self.send_json(self._wrap_response(response))
    
    def delete(self):
        raise NotImplementedYet
    
    def list(self):
        tasks = [response_producer.produce_task_response(self.request, task) for task in self.user.get_all_tasks()]
        self.send_json(self._wrap_response(tasks))
    
    def _get_allowed_params(self):
        return self.cleanPostedData(TaskHandler.ALLOWED_PARAMS)
    
    def _get_links(self):
        links = {}
        links['all_tasks'] = self.uri_for('all_tasks')
        links['create_task'] = self.uri_for('create_task')
        
        return links
    
    def _wrap_response(self, response):
        my_response = {}
        my_response['response'] = response
        my_response['links'] = self._get_links()
        
        return my_response
          
class ScheduleHandler(BaseHandler):
    @webapp2.cached_property
    def schedule(self):
        schedule_id = self.request.route_kwargs.get('schedule_id')
        return self.user.get_schedule(schedule_id)
    def create(self):
        raise NotImplementedYet
    
    def get(self, schedule_id = 'recurrent'):
        if self.schedule is None:
            if schedule_id != 'recurrent':
                raise RessourceNotFound('The schedule with id : ' + self.request.route_kwargs.get('schedule_id') + ' does not exist')
            self.user.init_schedule();
        response = response_producer.produce_schedule_response(self.request, self.schedule)
        self.send_response(response)
    
    def list(self):
        raise NotImplementedYet
    
    def update(self):
        raise NotImplementedYet
    
    def delete(self, schedule_id):
        raise NotImplementedYet
    
    def restart(self, schedule_id):
        schedule = self.user.get_schedule('recurrent')
        schedule.restart()
        response = produce_schedule_response(self.request, schedule)
        
        self.send_response(response)
    
    def _get_links(self):
        links = {}        
        return links
    
    def send_response(self, response):
        my_response = {}
        my_response['response'] = response
        self.send_json(my_response)
    
    def send_success(self):
        self.send_response("Operation Successfully executed")

class DayHandler(ScheduleHandler):
    @webapp2.cached_property
    def schedule(self):
        schedule = super(DayHandler, self).schedule
        if schedule is None:
            raise RessourceNotFound('The schedule with id : ' + self.request.route_kwargs.get('schedule_id') + ' does not exist')
        return schedule
    
    @webapp2.cached_property
    def day(self):
        day_id = self.request.route_kwargs.get('day_id')
        return self.schedule.get_day(int(day_id))
    
    def get(self, day_id, schedule_id = 'recurrent'):
        response = response_producer.produce_day_response(self.request, self.day, schedule_id)
        
        self.send_response(response)
    
    def list(self, schedule_id = 'recurrent'):
        days = self.chedule.get_all_days()
        response = [response_producer.produce_day_response(self.request, day, schedule_id) for day in days]
        
        self.send_response(response)
 
    
class SlotHandler(DayHandler):
    
    ALLOWED_PARAMS = ['duration', 'offset', 'executed', 'task_id']
    @webapp2.cached_property
    def slot(self):
        slot_id = self.request.route_kwargs.get('slot_id')
        return self.day.get_slot(slot_id)
    
    @required_params(['duration', 'offset'])
    def create(self, day_id, schedule_id = 'recurrent'):
        if (self.request.get('task_id')):
            slot = self._create_slot(day_id, schedule_id)
        else:
            slot = self._create_task_and_slot(day_id, schedule_id)
        response = response_producer.produce_slot_response(self.request, slot, schedule_id, day_id)
        
        self.send_response(response)
    
    def get(self, day_id, slot_id, schedule_id = 'recurrent'): 
        if self.slot is None:
            raise RessourceNotFound('The slot with id : '+ str(slot_id) + ' does not exist')
        
        response = response_producer.produce_slot_response(self.request, self.slot, schedule_id, day_id)
        
        self.send_response(response)
    
    def list(self, day_id, schedule_id = 'recurrent'):
        slots = self.day.get_slots()
        response = [response_producer.produce_slot_response(self.request, slot, schedule_id, day_id) for slot in slots]
        
        self.send_response(response)
    
    
    def update(self, day_id, slot_id, schedule_id = 'recurrent'):
        raise NotImplementedYet
        params = self._get_allowed_params()
        day = self._get_day(schedule_id, day_id)
        slot = day.update_slot(len(slot_id), **params)
        
        response = response_producer.produce_slot_response(self.request, slot, schedule_id, day_id)
        self.send_response(response)
        
    def delete(self, day_id, slot_id, schedule_id = 'recurrent'):
        self.user.unschedule_task(day_id = int(day_id), slot_id = int(slot_id), schedule_id=schedule_id)
        self.send_success()
    
    def set_executed(self, day_id, slot_id, executed, schedule_id = 'recurrent'):
        executed = executed == '1'
        self.schedule.set_executed(int(day_id), long(slot_id), executed)
        
        self.send_success()
    
    def _get_allowed_params(self):
        params = self.cleanPostedData(SlotHandler.ALLOWED_PARAMS)
        return params  
    
    def _create_slot(self, day_id, schedule_id):
        params = self._get_allowed_params()
        task_id = long(params['task_id'])
        duration = int(params['duration'])
        offset = int(params['offset'])
        slot = self.user.schedule_task(task_id, int(day_id), offset, duration, schedule_id)
        return slot
    
    def _create_task_and_slot(self, day_id, schedule_id):
        slot_parameters = self._get_allowed_params()
        task_parameters = self.cleanPostedData(TaskHandler.ALLOWED_PARAMS)
        if(task_parameters.get('name') is None):
            raise HandlerException("When the parameter task_id is not provided, the parameter name is required to create a new task")
        return self.user.create_task_and_slot(day_id, task_parameters, slot_parameters, schedule_id)
    
    
        