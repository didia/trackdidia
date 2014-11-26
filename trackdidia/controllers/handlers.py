from xml.sax.saxutils import escape
from django.utils import simplejson
from collections import OrderedDict
import logging
import webapp2
import jinja2
from google.appengine.api import users
import trackdidia.models.user as user_module
from trackdidia.models.custom_exceptions import HandlerException, RessourceNotFound,\
    NotImplementedYet, BadArgumentError

import response_producer

from trackdidia.models import utils
import trackdidia.models.stats as stat

jinja_environment = jinja2.Environment(extensions = ['jinja2.ext.autoescape'],
    loader = jinja2.FileSystemLoader('trackdidia/views'))


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

def user_required(handler):
    """
    Decorator that checks if there's a user associated with the current session.
    Will also fail if there's no session present.
    """
    def check_login(self, *args, **kargs):
        user_instance = users.get_current_user()
        if not user_instance:
            self.redirect(users.create_login_url(self.request.url))
        else:
            return handler(self, *args, **kargs)
            
        
    return check_login

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
    
    def send_response(self, response):   
        self.send_json(response)
    
    def send_success(self):
        self.send_response("Operation Successfully executed")
    

class CronHandler(BaseHandler):
    def get(self):
        users = user_module.get_all_users()
        number_processed = 0
        message = ""
        for user in users:
            schedule = user.get_schedule()
            message += stat.send_stat(user, schedule)
            message += "\n\n"
            if schedule:
                schedule.restart()
                number_processed += 1
        message = str(number_processed) + " schedules restarted\n\n" + message
        self.response.out.write(message)
    
                
class MainHandler(BaseHandler):
    
    @user_required
    def get(self):
        
        self.render_template('index.html')
        
    def get_template_context(self):
        context = dict()
        return context
    
    def discover(self):
        links = {}
        links['schedule'] = self.uri_for('get_schedule', schedule_id='recurrent')
        links['tasks'] = self.uri_for('all_tasks')
        links['create_task'] = self.uri_for('create_task')
        
        self.send_json({'links':links})
    

class TaskHandler(BaseHandler):
    ALLOWED_PARAMS = ['category', 'priority', 'name', 'description', 'location']
    
    @webapp2.cached_property
    def task(self):
        task_id = self.request.route_kwargs.get('task_id')
        if task_id:
            return self.user.get_task(long(task_id))
        return None
    @user_required
    @required_params(['name'])
    def create(self):
        params = self._get_allowed_params()
        name = params.pop('name')
        try:
            task = self.user.create_task(name, **params)
            response = response_producer.produce_task_response(self.request, task)
            self.send_response(response)
        except BadArgumentError as e:
            raise HandlerException(e)
        
    @user_required
    def get(self, task_id):
        if not self.task:
            raise RessourceNotFound("The task with id < " + str(task_id) + "> does not exist")
        response = response_producer.produce_task_response(self.request, self.task)
        self.send_response(response)
    
    @user_required
    def update(self, task_id):
        
        try:
            params = self._get_allowed_params()
            if len(params) == 0:
                raise HandlerException("Received an update request with no\
                parameter. An update must always include new values")
            task = self.user.update_task(long(task_id), **params)
            response = response_producer.produce_task_response(self.request, task)
            self.send_response(response)
        except BadArgumentError as e:
            raise HandlerException(e)
    
    @user_required
    def delete(self):
        raise NotImplementedYet
    
    @user_required
    def list(self):
        response = OrderedDict();
         
        tasks = [response_producer.produce_task_response(self.request, task) for task in self.user.get_all_tasks()]
        response['tasks'] = tasks;
        response['links'] = self._get_links()
        self.send_json(response)
    
    def _get_allowed_params(self):
        return self.cleanPostedData(TaskHandler.ALLOWED_PARAMS)
    
    def _get_links(self):
        links = {}
        links['all_tasks'] = self.uri_for('all_tasks')
        links['create_task'] = self.uri_for('create_task')
        
        return links

          
class ScheduleHandler(BaseHandler):
    @webapp2.cached_property
    def schedule(self):
        schedule_id = self.request.route_kwargs.get('schedule_id')
        return self.user.get_schedule(schedule_id)
    
    @user_required
    def create(self):
        raise NotImplementedYet
    
    @user_required
    def get(self, schedule_id = 'recurrent'):
        if self.schedule is None:
            if schedule_id != 'recurrent':
                raise RessourceNotFound('The schedule with id : ' + self.request.route_kwargs.get('schedule_id') + ' does not exist')
            self.schedule = self.user.init_schedule();
            
        response = response_producer.produce_schedule_response(self.request, self.schedule)
        self.send_response(response)
    
    @user_required
    def list(self):
        raise NotImplementedYet
    
    @user_required 
    def update(self):
        raise NotImplementedYet
    
    @user_required
    def delete(self, schedule_id):
        raise NotImplementedYet
    
    @user_required  
    def restart(self, schedule_id):
        schedule = self.user.get_schedule('recurrent')
        schedule.restart()
        response = response_producer.produce_schedule_response(self.request, schedule)
        
        self.send_response(response)
    
    @user_required
    def stat(self, schedule_id):
        schedule = self.user.get_schedule("recurrent")
        statistic = stat.get_stat(schedule)
        self.send_response(statistic)
        
    def _get_links(self):
        links = {}        
        return links


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
    
    @user_required
    def get(self, day_id, schedule_id = 'recurrent'):
        response = response_producer.produce_day_response(self.request, self.day, schedule_id)
        
        self.send_response(response)
    
    @user_required
    def list(self, schedule_id = 'recurrent'):
        days = self.schedule.get_all_days()
        response = [response_producer.produce_day_response(self.request, day, schedule_id) for day in days]
        
        self.send_response(response)
 
    
class SlotHandler(DayHandler):
    
    ALLOWED_PARAMS = ['duration', 'offset', 'executed', 'task_id']
    @webapp2.cached_property
    def slot(self):
        slot_id = self.request.route_kwargs.get('slot_id')
        return self.day.get_slot(slot_id)
    
    @user_required
    @required_params(['duration', 'offset'])
    def create(self, day_id, schedule_id = 'recurrent'):
        response = {}
        if (self.request.get('task_id')):
            slot = self._create_slot(day_id, schedule_id)
            response = response_producer.produce_slot_response(self.request, slot, day_id, schedule_id)
        else:
            task, slot = self._create_task_and_slot(day_id, schedule_id)
            response['task'] = response_producer.produce_task_response(self.request, task)
            response['slot'] = response_producer.produce_slot_response(self.request, slot, day_id, schedule_id)
        
        self.send_response(response)
    
    @user_required
    def get(self, day_id, slot_id, schedule_id = 'recurrent'): 
        if self.slot is None:
            raise RessourceNotFound('The slot with id : '+ str(slot_id) + ' does not exist')
        
        response = response_producer.produce_slot_response(self.request, self.slot, day_id, schedule_id)
        
        self.send_response(response)
    
    @user_required
    def list(self, day_id, schedule_id = 'recurrent'):
        slots = self.day.get_slots()
        response = [response_producer.produce_slot_response(self.request, slot, day_id, schedule_id) for slot in slots]
        
        self.send_response(response)
    
    @user_required
    def update(self, day_id, slot_id, schedule_id = 'recurrent'):
        raise NotImplementedYet
    
    @user_required
    def delete(self, day_id, slot_id, schedule_id = 'recurrent'):
        self.day.remove_slot(slot_id = int(slot_id))
        DayHandler.get(self, day_id, schedule_id);
    
    @user_required 
    def set_executed(self, day_id, slot_id, executed, schedule_id = 'recurrent'):
        executed = executed == '1'
        today_id = utils.get_today_id()
        if day_id > today_id:
            message = "Day id  " + str(day_id) + " must be "
            message += " inferior to today's id " + str(today_id)
            raise HandlerException(message) 
        
        slot = self.slot.set_executed(executed)
        response = response_producer.produce_slot_response(self.request, slot, day_id, schedule_id)
        
        self.send_response(response)
    
    def _get_allowed_params(self):
        params = self.cleanPostedData(SlotHandler.ALLOWED_PARAMS)
        return params  
    
    def _create_slot(self, day_id, schedule_id):
        params = self._get_allowed_params()
        task_id = long(params['task_id'])
        duration = int(params['duration'])
        offset = int(params['offset'])
        
        task = self.user.get_task(task_id)
        slot = self.day.add_slot(task, offset, duration)
        return slot
    
    def _create_task_and_slot(self, day_id, schedule_id):
        slot_parameters = self._get_allowed_params()
        duration = int(slot_parameters['duration'])
        offset = int(slot_parameters['offset'])
        task_parameters = self.cleanPostedData(TaskHandler.ALLOWED_PARAMS)
        if(task_parameters.get('name') is None):
            raise HandlerException("When the parameter task_id is not provided, the parameter name is required to create a new task")
        task = self.user.create_task(**task_parameters)
        slot = self.day.add_slot(task, offset, duration)
        return task, slot
    
    
        