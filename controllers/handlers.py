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


jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader(os.path.dirname(__file__)))
        
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
        
        self.response.write(exception)

        # If the exception is a HTTPException, use its error code.
        # Otherwise use a generic 500 error code.
        if isinstance(exception, webapp2.HTTPException):
            self.response.set_status(exception.code)
        else:
            self.response.set_status(500)
    
    def send_json(self, response):
        self.response.out.write(simplejson.dumps(response))
    
       
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
        pass 
    
    def list_all(self):
        tasks = [task.get_representation() for task in self.user.get_all_tasks()]
        response = OrderedDict()
        response['found'] = len(tasks)
        response['tasks'] = tasks
        
        self.send_json(response)
          

class TrackingHandler(BaseHandler):
    def create_schedule(self):
        pass
    
    def get_schedule(self):
        pass
    
    def update_schedule(self):
        pass
    
    def delete_schedule(self):
        pass
    
    def list_all_schedule(self):
        pass
    
    def get_day(self):
        pass
    
    def schedule_task(self):
        pass
    
    def unschedule_task(self):
        pass
    
    def set_executed_scheduled_task(self):
        pass 
